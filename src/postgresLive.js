// Live updates and offline reads for the day Firestore is no longer the
// listener. Nothing here runs unless `system/dataPaths.live` is "postgres".
// While that field is absent, the registers keep their Firestore listeners.
// The cutover notes (Auth, security rules, and the copy trigger) are at the
// top of functions/src/postgresCutover.js.

import {
  callFunction,
  logSyncError,
  noteServerReachable,
  pendingJournalEntries,
  REGISTER_CALL_TIMEOUT,
} from "./firebaseClient";

const POLL_MS = 4000;
const PAGES_PER_TICK = 8;
const CURSOR_PREFIX = "diamant-pg-cursor:";
const CUSTOMER_CACHE_KEY = "diamant-customer-cache-v1";
const TICKET_QUEUE_KEY = "diamant-ticket-claim-queue";
const CUSTOMER_CACHE_CAP = 2000;

const watchers = new Set();
let pollTimer = null;
let polling = false;
let pollFailed = false;
let stopCustomers = null;

function readJson(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Could not keep ${key} on this computer`, error);
    return false;
  }
}

function readCursor(name) {
  const cursor = readJson(CURSOR_PREFIX + name, null);
  if (!cursor || typeof cursor !== "object") return { updatedAt: "", id: "" };
  return { updatedAt: String(cursor.updatedAt || ""), id: String(cursor.id || "") };
}

function writeCursor(name, cursor) {
  if (!cursor?.updatedAt) return;
  writeJson(CURSOR_PREFIX + name, { updatedAt: cursor.updatedAt, id: cursor.id || "", version: cursor.version || 0 });
}

function readList(key) {
  if (!key) return [];
  const parsed = readJson(key, []);
  return Array.isArray(parsed) ? parsed.filter((item) => item && item.id) : [];
}

// Fold server deltas into the list the screen already shows. A product row
// that arrives without stock keeps the stock already on screen: catalog
// saves do not carry it. Version only moves forward for a given id.
export function applyRecordChanges(items, changes, versions, collectionName) {
  const byId = new Map((items || []).filter((item) => item?.id).map((item) => [item.id, item]));
  for (const change of changes || []) {
    if (!change?.id) continue;
    const seen = versions.get(change.id) || 0;
    if (change.version && change.version < seen) continue;
    if (change.version) versions.set(change.id, change.version);
    if (change.deleted) {
      byId.delete(change.id);
      continue;
    }
    const prev = byId.get(change.id);
    let data = { ...(change.data || {}) };
    if (collectionName === "products" && prev) {
      if (data.stock === undefined) data.stock = prev.stock;
      if (data.quantity === undefined) data.quantity = prev.quantity;
      if (data.imeis === undefined) data.imeis = prev.imeis;
    }
    byId.set(change.id, { ...data, id: change.id });
  }
  return [...byId.values()];
}

function deliver(watcher) {
  let list = watcher.items || [];
  const limitTo = Number(watcher.options.limitTo) || 0;
  if (limitTo > 0) {
    const field = watcher.options.orderByField || "createdAt";
    list = [...list]
      .sort((a, b) => String(b[field] || "").localeCompare(String(a[field] || "")) || String(b.id).localeCompare(String(a.id)))
      .slice(0, limitTo);
  }
  return list;
}

function specFor(name, group) {
  const cursor = readCursor(name);
  const limits = group.map((watcher) => Number(watcher.options.limitTo) || 0);
  const allRecent = limits.length > 0 && limits.every((limit) => limit > 0);
  const recent = allRecent ? Math.min(200, Math.max(...limits)) : 0;
  return {
    name,
    updatedAt: cursor.updatedAt,
    id: cursor.id,
    limit: recent ? recent : 400,
    recent,
  };
}

function groups() {
  const byName = new Map();
  for (const watcher of watchers) {
    if (!byName.has(watcher.name)) byName.set(watcher.name, []);
    byName.get(watcher.name).push(watcher);
  }
  return byName;
}

async function runPoll() {
  if (polling || !watchers.size) return;
  polling = true;
  try {
    const byName = groups();
    let pending = [...byName.keys()];
    for (let page = 0; page < PAGES_PER_TICK && pending.length; page += 1) {
      const collections = pending.map((name) => specFor(name, byName.get(name)));
      const result = await callFunction("pollRecordChanges", { collections }, REGISTER_CALL_TIMEOUT);
      if (result?.disabled) return;
      const again = [];
      for (const spec of collections) {
        const payload = result?.collections?.[spec.name];
        if (!payload) continue;
        writeCursor(spec.name, payload.cursor);
        for (const watcher of byName.get(spec.name) || []) {
          if (watcher.options.cacheChangesOnly) {
            watcher.options.onChanges?.(payload.changes);
            continue;
          }
          if (!watcher.versions) watcher.versions = new Map();
          watcher.items = applyRecordChanges(watcher.items, payload.changes, watcher.versions, watcher.name);
          watcher.onItems(deliver(watcher));
        }
        if (!payload.caughtUp) again.push(spec.name);
      }
      pending = again;
    }
    pollFailed = false;
    noteServerReachable(true);
    replayTicketClaims();
  } catch (error) {
    noteServerReachable(false);
    if (!pollFailed) {
      pollFailed = true;
      for (const watcher of watchers) {
        if (!watcher.options.cacheChangesOnly) watcher.onError?.(error);
      }
    }
  } finally {
    polling = false;
  }
}

function ensurePoll() {
  if (pollTimer || typeof window === "undefined") return;
  pollTimer = window.setInterval(() => { runPoll(); }, POLL_MS);
  window.addEventListener("online", runPoll);
  runPoll();
}

function stopPollIfIdle() {
  if (watchers.size || typeof window === "undefined") return;
  window.clearInterval(pollTimer);
  pollTimer = null;
  window.removeEventListener("online", runPoll);
}

export function watchPostgresCollection(collectionName, onItems, onError, options = {}) {
  const watcher = {
    name: collectionName,
    onItems,
    onError,
    options,
    items: options.cacheChangesOnly ? [] : readList(options.cacheKey),
    versions: new Map(),
  };
  watchers.add(watcher);
  if (!options.cacheChangesOnly && watcher.items.length) onItems(deliver(watcher));
  ensurePoll();
  return () => {
    watchers.delete(watcher);
    stopPollIfIdle();
  };
}

export function watchPostgresDocument(documentId, fallback, onValue, onError, options = {}) {
  if (typeof options.onCache === "function") options.onCache();
  return watchPostgresCollection("appState", (items) => {
    const found = (items || []).find((item) => item.id === documentId);
    onValue(found && found.items != null ? found.items : fallback);
  }, onError, options);
}

function readCustomerCache() {
  const parsed = readJson(CUSTOMER_CACHE_KEY, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeCustomerCache(byId) {
  const rows = Object.values(byId);
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const kept = {};
  rows.slice(0, CUSTOMER_CACHE_CAP).forEach((customer) => {
    if (customer?.id) kept[customer.id] = customer;
  });
  writeJson(CUSTOMER_CACHE_KEY, kept);
}

function mergeCustomerCache(changes) {
  const byId = readCustomerCache();
  for (const change of changes || []) {
    if (!change?.id) continue;
    if (change.deleted) delete byId[change.id];
    else byId[change.id] = { ...(change.data || {}), id: change.id };
  }
  writeCustomerCache(byId);
}

function customersOnHand() {
  const byId = readCustomerCache();
  for (const entry of pendingJournalEntries()) {
    if (entry?.type === "customerDelete" && entry.id) delete byId[entry.id];
    if (entry?.type === "customerSave" && entry.id) byId[entry.id] = { ...(entry.data || {}), id: entry.id };
  }
  return Object.values(byId);
}

function rememberCustomers(customers) {
  if (!customers?.length) return;
  const byId = readCustomerCache();
  for (const customer of customers) {
    if (customer?.id) byId[customer.id] = customer;
  }
  writeCustomerCache(byId);
}

export function notePostgresLive(on) {
  if (typeof window === "undefined") return;
  if (!on) {
    if (stopCustomers) stopCustomers();
    stopCustomers = null;
    return;
  }
  if (stopCustomers) return;
  stopCustomers = watchPostgresCollection("customers", () => {}, (error) => {
    logSyncError("PostgreSQL customer cache sync failed", error);
  }, {
    cacheChangesOnly: true,
    onChanges: mergeCustomerCache,
  });
}

function readTicketQueue() {
  const parsed = readJson(TICKET_QUEUE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((entry) => entry?.ticketNumber) : [];
}

function claimKey(entry) {
  return `${entry.ticketNumber}:${entry.reportId || ""}`;
}

function rememberTicketClaim(entry) {
  const queue = readTicketQueue().filter((item) => claimKey(item) !== claimKey(entry));
  queue.push(entry);
  writeJson(TICKET_QUEUE_KEY, queue);
}

function forgetTicketClaim(entry) {
  writeJson(TICKET_QUEUE_KEY, readTicketQueue().filter((item) => claimKey(item) !== claimKey(entry)));
}

let replayingClaims = false;

async function replayTicketClaims() {
  if (replayingClaims) return;
  const queued = readTicketQueue();
  if (!queued.length) return;
  replayingClaims = true;
  try {
    for (const entry of queued) {
      const result = await callFunction("claimRepairTicketPg", {
        ticketNumber: entry.ticketNumber,
        reportId: entry.reportId || "",
      }, { timeout: 6000 });
      if (result?.status === "claimed" || result?.status === "taken") forgetTicketClaim(entry);
      else return;
    }
  } catch {
    // Still offline. The queue stays and the next poll tries again.
  } finally {
    replayingClaims = false;
  }
}

export async function claimRepairTicketWithoutFirestore(ticketNumber, reportId) {
  const number = String(ticketNumber || "").trim();
  if (!number) return "unconfirmed";
  const entry = { ticketNumber: number, reportId: String(reportId || "") };
  rememberTicketClaim(entry);
  try {
    const result = await callFunction("claimRepairTicketPg", entry, { timeout: 6000 });
    if (result?.status === "claimed" || result?.status === "taken") {
      forgetTicketClaim(entry);
      return result.status;
    }
    return "unconfirmed";
  } catch {
    return "unconfirmed";
  }
}

export async function allocateRepairTicketWithoutFirestore(startAt, { reportId = "" } = {}) {
  try {
    const result = await callFunction("allocateRepairTicketPg", {
      startAt,
      reportId: String(reportId || ""),
    }, { timeout: 6000 });
    return result?.number || null;
  } catch {
    return null;
  }
}

async function customerCall(data) {
  const result = await callFunction("findCustomerRecords", data, REGISTER_CALL_TIMEOUT);
  if (result?.disabled) {
    const error = new Error("Customer lookup is still on the usual path.");
    error.code = "functions/failed-precondition";
    throw error;
  }
  rememberCustomers(result?.customers || []);
  return result?.customers || [];
}

function matchesDigits(customer, digits) {
  return customer?.phoneDigits === digits || customer?.mobileDigits === digits;
}

export async function findCustomerByPhoneWithoutFirestore(digits) {
  const clean = String(digits || "").trim();
  if (!clean) return null;
  try {
    const found = await customerCall({ digits: clean });
    return found[0] || null;
  } catch {
    return customersOnHand().find((customer) => matchesDigits(customer, clean)) || null;
  }
}

export async function searchCustomersByPhonePrefixWithoutFirestore(prefix, max = 8) {
  const clean = String(prefix || "").trim();
  if (!clean) return [];
  try {
    return await customerCall({ prefix: clean, limit: max });
  } catch {
    return customersOnHand()
      .filter((customer) => String(customer.phoneDigits || "").startsWith(clean)
        || String(customer.mobileDigits || "").startsWith(clean))
      .slice(0, max);
  }
}

export async function listCustomersPageWithoutFirestore({ pageSize = 25, afterId = "", search = "" } = {}) {
  const clean = String(search || "").trim();
  const digits = clean.replace(/\D/g, "");
  const cap = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "";
  try {
    if (digits) return await customerCall({ prefix: digits, limit: pageSize, afterId });
    if (cap) return await customerCall({ namePrefix: cap, limit: pageSize, afterId });
    return await customerCall({ limit: pageSize, afterId });
  } catch {
    let rows = customersOnHand();
    if (digits) rows = rows.filter((customer) => String(customer.phoneDigits || "").startsWith(digits));
    else if (cap) rows = rows.filter((customer) => String(customer.name || "").startsWith(cap));
    rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")) || String(a.id).localeCompare(String(b.id)));
    if (afterId) {
      const index = rows.findIndex((customer) => customer.id === afterId);
      if (index >= 0) rows = rows.slice(index + 1);
    }
    return rows.slice(0, pageSize);
  }
}
