import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  runTransaction,
  setDoc,
  startAfter,
  where,
  writeBatch,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { normalizeFirestoreDoc } from "./utils";
import {
  allocateRepairTicketWithoutFirestore,
  claimRepairTicketWithoutFirestore,
  findCustomerByPhoneWithoutFirestore,
  listCustomersPageWithoutFirestore,
  notePostgresLive,
  searchCustomersByPhonePrefixWithoutFirestore,
  watchPostgresCollection,
  watchPostgresDocument,
} from "./postgresLive";

let firebasePromise;
// The resolved handles, kept so `currentAuthUid` below can answer without
// awaiting anything. Set once, the first time the SDK finishes initialising.
let firebaseHandles = null;

function firebaseUnavailable() {
  const error = new Error(
    "Firebase Hosting config not available — running in local-only mode (data saved in this browser).",
  );
  error.code = "firebase-unavailable";
  return error;
}

async function getFirebase() {
  if (!firebasePromise) {
    firebasePromise = fetch("/__/firebase/init.json")
      .then(async (response) => {
        // When the app is not served by Firebase Hosting (e.g. `vite` dev), this
        // path returns index.html, so guard against a non-JSON response instead
        // of letting JSON.parse throw a noisy error for every collection.
        const text = await response.text();
        let firebaseConfig;
        try {
          firebaseConfig = JSON.parse(text);
        } catch {
          throw firebaseUnavailable();
        }
        if (!response.ok || !firebaseConfig || !firebaseConfig.projectId) {
          throw firebaseUnavailable();
        }
        const app = initializeApp(firebaseConfig);
        return {
          auth: getAuth(app),
          // Auto-detect long-polling so the database still works on networks /
          // filters that break Firestore's streaming (WebChannel) connection.
          // Persist the cache to IndexedDB so a hard refresh resumes from the
          // last sync (reading only changed docs) instead of re-reading every
          // document. The multi-tab manager shares one cache across open tabs.
          db: initializeFirestore(app, {
            experimentalAutoDetectLongPolling: true,
            localCache: persistentLocalCache({
              tabManager: persistentMultipleTabManager(),
            }),
          }),
          functions: getFunctions(app),
        };
      })
      .then((handles) => {
        firebaseHandles = handles;
        return handles;
      });
  }

  return firebasePromise;
}

// --- Cloud reachability ------------------------------------------------------
// Tracks whether Firestore's server is actually reachable so the UI can warn
// staff that their edits aren't saving (e.g. a content filter silently blocking
// firestore.googleapis.com). `online` is null until we know, true once a live
// server snapshot arrives, false on a listener error or if the first server
// snapshot never shows up.
const cloudStatus = { online: null, listeners: new Set() };
let connectivityTimer = null;

function setCloudOnline(online) {
  if (online === true && connectivityTimer) {
    clearTimeout(connectivityTimer);
    connectivityTimer = null;
  }
  if (cloudStatus.online === online) return;
  cloudStatus.online = online;
  cloudStatus.listeners.forEach((listener) => listener(online));
}

// The Postgres poller reports reachability the same way a server snapshot does.
// Nothing calls this while the live flag is off.
export function noteServerReachable(online) {
  setCloudOnline(online === true);
}

function armConnectivityTimeout() {
  if (connectivityTimer || cloudStatus.online === true) return;
  connectivityTimer = setTimeout(() => {
    connectivityTimer = null;
    if (cloudStatus.online !== true) setCloudOnline(false);
  }, 12000);
}

export function subscribeCloudStatus(listener) {
  cloudStatus.listeners.add(listener);
  listener(cloudStatus.online);
  return () => cloudStatus.listeners.delete(listener);
}

// A snapshot served purely from the local cache (never confirmed by the server)
// means we're offline; one confirmed by the server means we're online.
function reportSnapshotStatus(snapshot) {
  if (!snapshot.metadata.fromCache) setCloudOnline(true);
}

let offlineLogged = false;

// Collapses the "no Firebase config" case into a single friendly message, while
// still surfacing real Firestore errors.
export function logSyncError(scope, error) {
  if (error && error.code === "firebase-unavailable") {
    if (!offlineLogged) {
      offlineLogged = true;
      console.info("Diamant Telecom: Firestore sync is off (local-only mode). Data is saved in this browser.");
    }
    return;
  }
  console.error(scope, error);
}

// Resolves with the signed-in user. The app only mounts data hooks once a user
// is authenticated, so currentUser is normally already set.
export async function ensureFirebaseAuth() {
  const { auth } = await getFirebase();
  if (auth.currentUser) return auth.currentUser;

  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsubscribe();
        resolve(user);
      }
    });
    setTimeout(() => {
      unsubscribe();
      reject(new Error("Not signed in."));
    }, 10000);
  });
}

// Watches Firebase Auth and reports sign-in state + whether the user is an admin
// (via the `role: 'admin'` custom claim).
export function subscribeAuth(onChange) {
  let unsubscribe = () => {};
  getFirebase()
    .then(({ auth }) => {
      unsubscribe = onAuthStateChanged(auth, async (user) => {
        if (!user) {
          onChange({ status: "signed-out", user: null, isAdmin: false });
          return;
        }
        let isAdmin = false;
        try {
          const result = await user.getIdTokenResult();
          isAdmin = result.claims.role === "admin" || result.claims.admin === true;
        } catch {
          isAdmin = false;
        }
        onChange({ status: "signed-in", user, isAdmin });
      });
    })
    .catch((error) => onChange({ status: "error", user: null, isAdmin: false, error }));
  return () => unsubscribe();
}

export async function signInWithEmail(email, password) {
  const { auth } = await getFirebase();
  const credential = await signInWithEmailAndPassword(auth, String(email || "").trim(), password);
  return credential.user;
}

export async function signOutUser() {
  const { auth } = await getFirebase();
  await signOut(auth);
}

export async function sendReset(email) {
  const { auth } = await getFirebase();
  await sendPasswordResetEmail(auth, String(email || "").trim());
}

// fetch() for our HTTP Cloud Functions, carrying the employee's sign-in. Those
// functions refuse any request without it.
export async function authorizedFetch(url, init = {}) {
  const user = await ensureFirebaseAuth();
  const token = await user.getIdToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

// Calls an admin-only Cloud Function (callable) such as employee management.
export async function callFunction(name, data, options) {
  const { functions } = await getFirebase();
  const callable = httpsCallable(functions, name, options);
  const result = await callable(data || {});
  return result.data;
}

// A register save that has not answered in this long goes the other way (or
// back to its outbox) instead of holding the screen for the SDK's 70 seconds.
// Sending the same save twice is harmless: the server skips what it already has.
export const REGISTER_CALL_TIMEOUT = { timeout: 30000 };

// Who is signed in, right now, without waiting for anything.
export function currentAuthUid() {
  return firebaseHandles?.auth?.currentUser?.uid || "";
}

// Stamp a record with who filed it — synchronously, on purpose.
//
// This used to await `ensureFirebaseAuth()`, which sat in front of every save in
// the app: a repair, a sale, a return reached React state (and therefore the
// Firestore write and the offline outbox) only after auth answered. That is up
// to ten seconds, and if the page went away in the meantime — a reload, the
// kiosk shortcut restarting, the tab closed after the print dialog — it never
// happened at all. In that window the record existed nowhere: not in state, not
// in the outbox, not in the cloud. A repair's label had already printed and gone
// onto the customer's phone, so the shop believed it was booked in, and the
// ticket number it carried was still free for the next customer to be given.
//
// The uid is a nicety. The record is the point, so the record goes first: this
// reads the user the SDK already has, and records an empty id in the rare case
// it has none rather than making the save wait for one.
export function stampAuthMetadata(data) {
  return { ...data, servedByEmployeeId: currentAuthUid() || data.servedByEmployeeId || "" };
}

// How long to wait for the server to answer a ticket claim before giving up on
// it. Offline, Firestore holds the write and the promise simply never settles,
// so an unbounded wait would leave every intake's claim hanging forever.
const TICKET_CLAIM_TIMEOUT_MS = 6000;
const CLAIM_TIMEOUT = Symbol("claim-timeout");

function withClaimTimeout(work) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(CLAIM_TIMEOUT), TICKET_CLAIM_TIMEOUT_MS));
  // The work is still owed to the server either way; only our waiting stops.
  work.catch(() => {});
  return Promise.race([work, timeout]);
}

// A claim document this register created for this repair is not a clash.
// Allocate writes the document and then stops waiting if the shop's connection
// is slow; the write still lands, and the follow-up claim used to read "taken"
// and move the repair off the number already printed on the phone.
function ownsRepairTicket(data, reportId) {
  const ownerReport = String(data?.reportId || "");
  const owner = String(data?.claimedBy || "");
  const me = String(currentAuthUid() || "");
  if (reportId && ownerReport === String(reportId)) return true;
  return Boolean(me && owner === me && !ownerReport);
}

// Claim a repair ticket number for one repair. Resolves "taken" when another
// register already owns the number, "claimed" when this one got it, and
// "unconfirmed" when nothing could be established — offline intake still has to
// hand the customer a numbered label, so an unanswered claim never blocks
// anything. The caller renumbers only on "taken".
//
// The existing document is looked for before writing, rather than reading the
// write's own failure, because `permission-denied` alone cannot tell "that
// number is already someone's" from "these rules were never deployed". Guessing
// wrong the second way would renumber every repair in the shop, so a claim that
// cannot even be read is reported as unconfirmed and the duplicate check in the
// app stays in charge.
export async function claimRepairTicket(ticketNumber, reportId) {
  if (postgresLiveEnabled()) return claimRepairTicketWithoutFirestore(ticketNumber, reportId);
  const number = String(ticketNumber || "").trim();
  if (!number) return "unconfirmed";

  let ticketRef;
  try {
    const { db } = await getFirebase();
    ticketRef = doc(db, "repairTickets", number);
    const existing = await withClaimTimeout(getDoc(ticketRef));
    if (existing === CLAIM_TIMEOUT) return "unconfirmed";
    if (existing.exists()) return ownsRepairTicket(existing.data(), reportId) ? "claimed" : "taken";
  } catch (error) {
    if (error?.code !== "permission-denied") logSyncError("Firestore repair ticket read failed", error);
    return "unconfirmed";
  }

  try {
    const written = await withClaimTimeout(setDoc(ticketRef, {
      reportId: String(reportId || ""),
      claimedBy: currentAuthUid(),
      claimedAt: new Date().toISOString(),
    }));
    // Offline, Firestore holds the write and answers nobody. It will land on the
    // number this repair is already using, which is the outcome we wanted anyway.
    return written === CLAIM_TIMEOUT ? "unconfirmed" : "claimed";
  } catch (error) {
    // The read above found nothing, so a refusal now is the rules refusing to let
    // an existing document be overwritten: another register claimed it in between.
    // Our own allocate write can win that race after we stopped waiting for it,
    // and that one is still ours.
    if (error?.code === "permission-denied") {
      try {
        const existing = await withClaimTimeout(getDoc(ticketRef));
        if (existing !== CLAIM_TIMEOUT && existing.exists() && ownsRepairTicket(existing.data(), reportId)) {
          return "claimed";
        }
      } catch (readError) {
        if (readError?.code !== "permission-denied") logSyncError("Firestore repair ticket reread failed", readError);
      }
      return "taken";
    }
    logSyncError("Firestore repair ticket claim failed", error);
    return "unconfirmed";
  }
}

// Take a ticket number that is nobody else's, before it is printed on anything.
//
// The number used to be worked out from the reports this register could see, so
// two counters serving customers in the same moment both landed on the same
// next number and only found out afterwards — by which time a label was stuck
// to a phone and its owner had gone home. `repairTickets/{number}` is the
// mutex: the rules allow create and forbid update, so exactly one register can
// ever create a given number. Walking forward from `startAt` until a create
// succeeds hands back a number that is already ours.
//
// Returns null when nothing can be established (offline, or rules that were
// never deployed). The caller then falls back to the local guess, where the
// after-the-fact claim and renumber remain the net they always were.
export async function allocateRepairTicketNumber(startAt, { reportId = "", maxTries = 25 } = {}) {
  if (postgresLiveEnabled()) return allocateRepairTicketWithoutFirestore(startAt, { reportId });
  let candidate = Number(startAt) || 0;
  if (!Number.isFinite(candidate) || candidate < 100001) candidate = 100001;

  let db;
  try {
    ({ db } = await getFirebase());
  } catch (error) {
    logSyncError("Firestore unavailable for ticket allocation", error);
    return null;
  }

  for (let tries = 0; tries < maxTries; tries += 1, candidate += 1) {
    if (candidate > 999999) return null;
    const number = String(candidate);
    try {
      const written = await withClaimTimeout(setDoc(doc(db, "repairTickets", number), {
        reportId: String(reportId || ""),
        claimedBy: currentAuthUid(),
        claimedAt: new Date().toISOString(),
      }));
      // Offline the write is held and nobody answers. We cannot say this number
      // is ours, so we do not pretend it is.
      if (written === CLAIM_TIMEOUT) return null;
      return number;
    } catch (error) {
      // Somebody already owns it: step on to the next.
      if (error?.code === "permission-denied") continue;
      logSyncError("Firestore ticket allocation failed", error);
      return null;
    }
  }
  return null;
}

// `options.limitTo` caps the live listener to the N most recent docs (ordered by
// `options.orderByField`, default "createdAt", descending) so large collections
// like notificationLogs don't re-read their whole history on every load.
function watchCollectionFirestore(collectionName, onItems, onError, options = {}) {
  let unsubscribe = () => {};
  let cancelled = false;
  watchDataPaths();

  ensureFirebaseAuth()
    .then(() => getFirebase())
    .then(({ db }) => {
      if (cancelled) return;
      const base = collection(db, collectionName);
      const source = options.limitTo
        ? query(base, orderBy(options.orderByField || "createdAt", "desc"), limit(options.limitTo))
        : base;
      unsubscribe = onSnapshot(
        source,
        { includeMetadataChanges: true },
        (snapshot) => {
          reportSnapshotStatus(snapshot);
          onItems(snapshot.docs.map((item) => normalizeFirestoreDoc(item.id, item.data())));
        },
        (error) => {
          setCloudOnline(false);
          onError(error);
        },
      );
      armConnectivityTimeout();
    })
    .catch(onError);

  return () => {
    cancelled = true;
    unsubscribe();
  };
}

// Firestore listeners stay in place until system/dataPaths.live is "postgres".
// A missing field is off, and hearing that again does not restart the listener.
export function watchCollection(collectionName, onItems, onError, options = {}) {
  let stop = () => {};
  let mode = "";
  const apply = (live) => {
    const next = live ? "pg" : "fs";
    if (mode === next) return;
    mode = next;
    stop();
    stop = next === "pg"
      ? watchPostgresCollection(collectionName, onItems, onError, options)
      : watchCollectionFirestore(collectionName, onItems, onError, options);
  };
  const unsub = subscribePostgresLive((live) => {
    notePostgresLive(live);
    apply(live);
  });
  return () => {
    unsub();
    stop();
  };
}

function watchAppStateFirestore(documentId, fallback, onValue, onError) {
  let unsubscribe = () => {};
  let cancelled = false;

  ensureFirebaseAuth()
    .then(() => getFirebase())
    .then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "appState", documentId),
        { includeMetadataChanges: true },
        (snapshot) => {
          reportSnapshotStatus(snapshot);
          onValue(snapshot.exists() ? snapshot.data().items || fallback : fallback);
        },
        (error) => {
          setCloudOnline(false);
          onError(error);
        },
      );
      armConnectivityTimeout();
    })
    .catch(onError);

  return () => {
    cancelled = true;
    unsubscribe();
  };
}

export function watchAppStateDocument(documentId, fallback, onValue, onError, options = {}) {
  let stop = () => {};
  let mode = "";
  const apply = (live) => {
    const next = live ? "pg" : "fs";
    if (mode === next) return;
    mode = next;
    stop();
    stop = next === "pg"
      ? watchPostgresDocument(documentId, fallback, onValue, onError, options)
      : watchAppStateFirestore(documentId, fallback, onValue, onError);
  };
  const unsub = subscribePostgresLive((live) => {
    notePostgresLive(live);
    apply(live);
  });
  return () => {
    unsub();
    stop();
  };
}

// ---- Which parts of the app save through PostgreSQL ------------------------
// `system/dataPaths` lists them. Until it is read (or if it can't be), every
// save goes straight to Firestore, the way it always has.
const dataPathState = { value: {}, started: false };
const liveFlagListeners = new Set();

// Off unless system/dataPaths.live is exactly "postgres". Unset means the
// registers keep using Firestore for live updates, tickets, and card locks.
export function postgresLiveEnabled() {
  return dataPathState.value?.live === "postgres";
}

function publishLiveFlag() {
  const on = postgresLiveEnabled();
  liveFlagListeners.forEach((listener) => listener(on));
}

export function subscribePostgresLive(listener) {
  watchDataPaths();
  liveFlagListeners.add(listener);
  listener(postgresLiveEnabled());
  return () => liveFlagListeners.delete(listener);
}

function watchDataPaths() {
  if (dataPathState.started) return;
  dataPathState.started = true;
  ensureFirebaseAuth()
    .then(() => getFirebase())
    .then(({ db }) => {
      onSnapshot(
        doc(db, "system", "dataPaths"),
        (snapshot) => {
          dataPathState.value = snapshot.exists() ? snapshot.data() || {} : {};
          publishLiveFlag();
          replayRecordJournal();
        },
        () => {
          dataPathState.value = {};
          publishLiveFlag();
          replayRecordJournal();
        },
      );
    })
    .catch(() => {});
}

export function savesToPostgres(area) {
  watchDataPaths();
  const list = dataPathState.value.collections;
  return Array.isArray(list) && list.includes(area);
}

// A refusal is final; anything else (no connection, the database down) means
// the save goes the usual way instead.
const FINAL_ERRORS = new Set([
  "functions/permission-denied",
  "functions/invalid-argument",
  "functions/unauthenticated",
  "functions/not-found",
]);
const OPS_PER_CALL = 200;

async function saveViaPostgres(ops) {
  try {
    for (let index = 0; index < ops.length; index += OPS_PER_CALL) {
      await callFunction("saveRecords", { ops: ops.slice(index, index + OPS_PER_CALL) }, REGISTER_CALL_TIMEOUT);
    }
    return true;
  } catch (error) {
    if (FINAL_ERRORS.has(error?.code)) throw error;
    console.warn("Diamant Telecom: PostgreSQL save did not go through, saving to Firestore instead.", error);
    return false;
  }
}

function saveOpsFor(collectionName, items, removedIds = []) {
  const type = collectionName === "products" ? "merge" : "set";
  return [
    ...items.map((item) => ({ collection: collectionName, id: item.id, type, data: asStoredItem(collectionName, item) })),
    ...removedIds.map((id) => ({ collection: collectionName, id, type: "delete" })),
  ];
}

async function commitBatches(db, operations) {
  const chunkSize = 450;
  for (let index = 0; index < operations.length; index += chunkSize) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(index, index + chunkSize)) {
      operation(batch);
    }
    await batch.commit();
  }
}

// Catalog edits must not carry stock. A merge that omits these fields leaves
// the balances already stored; the stock function is the only writer of them.
function asStoredItem(collectionName, item) {
  if (collectionName !== "products" || !item) return item;
  const { stock, quantity, imeis, ...catalog } = item;
  return catalog;
}

function writeStoredItem(batch, collectionRef, collectionName, item) {
  const ref = doc(collectionRef, item.id);
  const stored = asStoredItem(collectionName, item);
  if (collectionName === "products") batch.set(ref, stored, { merge: true });
  else batch.set(ref, stored);
}

// Each save resolves with where it went, "postgres" or "firestore".
export async function upsertCollectionItems(collectionName, items) {
  await ensureFirebaseAuth();
  if (items.length && savesToPostgres(collectionName) && await saveViaPostgres(saveOpsFor(collectionName, items))) {
    return "postgres";
  }
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);

  await commitBatches(
    db,
    items.map((item) => (batch) => writeStoredItem(batch, collectionRef, collectionName, item)),
  );
  return "firestore";
}

// Removes specific documents by id. Used by the sync outbox when it replays a
// deletion that couldn't reach Firestore at the time it was made.
export async function deleteCollectionItems(collectionName, ids) {
  if (!ids.length) return "firestore";
  await ensureFirebaseAuth();
  if (savesToPostgres(collectionName) && await saveViaPostgres(saveOpsFor(collectionName, [], ids))) {
    return "postgres";
  }
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);

  await commitBatches(
    db,
    ids.map((id) => (batch) => batch.delete(doc(collectionRef, id))),
  );
  return "firestore";
}

// Stable JSON for change detection: sort object keys so two equal objects with a
// different key order aren't treated as "changed" and don't trigger a write.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function syncCollectionItems(collectionName, previousItems, nextItems) {
  await ensureFirebaseAuth();
  const previousById = new Map(previousItems.map((item) => [item.id, item]));
  const nextIds = new Set(nextItems.map((item) => item.id));
  // Only write docs that are new or whose contents actually changed, so editing
  // one item in a large collection doesn't rewrite every document.
  const changed = nextItems.filter((item) => {
    const previous = previousById.get(item.id);
    return !previous || stableStringify(previous) !== stableStringify(item);
  });
  const removed = [...previousById.keys()].filter((id) => !nextIds.has(id));
  if (!changed.length && !removed.length) return "firestore";

  if (savesToPostgres(collectionName) && await saveViaPostgres(saveOpsFor(collectionName, changed, removed))) {
    return "postgres";
  }
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);
  await commitBatches(db, [
    ...changed.map((item) => (batch) => writeStoredItem(batch, collectionRef, collectionName, item)),
    ...removed.map((id) => (batch) => batch.delete(doc(collectionRef, id))),
  ]);
  return "firestore";
}

export async function replaceAppStateDocument(documentId, items) {
  await ensureFirebaseAuth();
  if (savesToPostgres("appState")
    && await saveViaPostgres([{ collection: "appState", id: documentId, type: "set", data: { items } }])) {
    return;
  }
  const { db } = await getFirebase();
  await setDoc(doc(db, "appState", documentId), { items });
}

// ---- Customers: query on demand instead of loading the whole collection ----

function toDoc(snap) {
  return normalizeFirestoreDoc(snap.id, snap.data());
}

// Exact lookup by the local 10-digit number — tries phoneDigits then mobileDigits.
export async function findCustomerByPhone(digits) {
  if (postgresLiveEnabled()) return findCustomerByPhoneWithoutFirestore(digits);
  const clean = String(digits || "").trim();
  if (!clean) return null;
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const customers = collection(db, "customers");
  for (const field of ["phoneDigits", "mobileDigits"]) {
    const snap = await getDocs(query(customers, where(field, "==", clean), limit(1)));
    if (!snap.empty) return toDoc(snap.docs[0]);
  }
  return null;
}

// Type-ahead: customers whose phoneDigits start with `prefix` (prefix match).
export async function searchCustomersByPhonePrefix(prefix, max = 8) {
  if (postgresLiveEnabled()) return searchCustomersByPhonePrefixWithoutFirestore(prefix, max);
  const clean = String(prefix || "").trim();
  if (!clean) return [];
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const customers = collection(db, "customers");
  const snap = await getDocs(
    query(customers, where("phoneDigits", ">=", clean), where("phoneDigits", "<", `${clean}`), limit(max)),
  );
  return snap.docs.map(toDoc);
}

// CRM page: one page at a time. `search` (digits) does a phone-prefix query;
// otherwise lists by name. `afterDoc` is the last doc from the previous page.
export async function listCustomersPage({ pageSize = 25, afterId = "", search = "" } = {}) {
  if (postgresLiveEnabled()) return listCustomersPageWithoutFirestore({ pageSize, afterId, search });
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const customers = collection(db, "customers");
  const clean = String(search || "").trim();
  const digits = clean.replace(/\D/g, "");

  let q;
  if (digits) {
    q = query(customers, where("phoneDigits", ">=", digits), where("phoneDigits", "<", `${digits}`), limit(pageSize));
  } else if (clean) {
    // Name prefix (case-sensitive on the stored, title-cased name).
    const cap = clean.charAt(0).toUpperCase() + clean.slice(1);
    q = query(customers, orderBy("name"), where("name", ">=", cap), where("name", "<", `${cap}`), limit(pageSize));
  } else {
    q = query(customers, orderBy("name"), limit(pageSize));
  }

  if (afterId) {
    const cursor = await getDocs(query(customers, where("__name__", "==", afterId), limit(1)));
    if (!cursor.empty) q = query(q, startAfter(cursor.docs[0]));
  }

  const snap = await getDocs(q);
  return snap.docs.map(toDoc);
}

// Merged, not replaced. The CRM form writes the contact fields it knows about;
// a customer's account balance and its history are written by a different
// screen entirely, and a plain setDoc would wipe them every time somebody
// corrected a spelling.
// ---- Customer saves still on their way -------------------------------------
// Firestore kept a pending write on disk the moment it was made. A call to the
// server keeps nothing: if the page goes away while the server is still waking
// up, the change existed only in that page. Each customer save, removal and
// balance change is written here first and taken off once it has an answer;
// whatever is left when the app next opens is sent again. The server skips a
// save it already has, and a balance change carries the same entry id every
// time it is sent, so it is never applied twice.
const RECORD_JOURNAL_KEY = "diamant-record-journal";
const JOURNAL_RETRY_MS = 30000;
const journalInFlight = new Set();
let journalReplaying = false;
let journalRetryTimer = null;

function readJournal() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_JOURNAL_KEY) || "null");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Customer saves still waiting on this register. The Postgres lookup reads
// them so an offline sale can find a customer that was just typed in here.
export function pendingJournalEntries() {
  return Object.values(readJournal());
}

function writeJournal(journal) {
  try {
    if (!Object.keys(journal).length) localStorage.removeItem(RECORD_JOURNAL_KEY);
    else localStorage.setItem(RECORD_JOURNAL_KEY, JSON.stringify(journal));
  } catch (error) {
    console.error("Could not keep a pending customer save on this computer", error);
  }
}

function journalPut(key, entry) {
  const seq = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const journal = readJournal();
  journal[key] = { ...entry, seq };
  writeJournal(journal);
  journalInFlight.add(seq);
  return seq;
}

function journalClear(key, seq) {
  journalInFlight.delete(seq);
  const journal = readJournal();
  if (journal[key]?.seq !== seq) return;
  delete journal[key];
  writeJournal(journal);
}

// The UI waits on these, so an answer of either kind reaches somebody and the
// entry is done with. Only a page that went away mid-call leaves one behind.
async function withJournal(key, entry, work) {
  const seq = journalPut(key, entry);
  try {
    return await work();
  } finally {
    journalClear(key, seq);
  }
}

function isFinalSaveError(error) {
  return FINAL_ERRORS.has(error?.code) || error?.final === true;
}

async function runJournalEntry(entry) {
  if (entry.type === "customerSave") return writeCustomer(entry.id, entry.data);
  if (entry.type === "customerDelete") return removeCustomer(entry.id);
  if (entry.type === "balance") return applyBalanceChange(entry);
  return null;
}

function scheduleJournalRetry() {
  if (journalRetryTimer || typeof window === "undefined") return;
  journalRetryTimer = window.setTimeout(() => {
    journalRetryTimer = null;
    replayRecordJournal();
  }, JOURNAL_RETRY_MS);
}

async function replayRecordJournal() {
  if (journalReplaying) return;
  const waiting = Object.entries(readJournal()).filter(([, entry]) => entry?.seq && !journalInFlight.has(entry.seq));
  if (!waiting.length) return;
  journalReplaying = true;
  let left = false;
  try {
    await ensureFirebaseAuth();
    for (const [key, entry] of waiting) {
      journalInFlight.add(entry.seq);
      try {
        await runJournalEntry(entry);
        journalClear(key, entry.seq);
      } catch (error) {
        if (isFinalSaveError(error)) {
          console.error(`Diamant Telecom: a saved ${entry.type} was refused when it was sent again.`, entry, error);
          journalClear(key, entry.seq);
        } else {
          journalInFlight.delete(entry.seq);
          left = true;
        }
      }
    }
  } catch {
    left = true;
  } finally {
    journalReplaying = false;
  }
  if (left) scheduleJournalRetry();
}

async function writeCustomer(id, data) {
  const { db } = await getFirebase();
  if (savesToPostgres("customers")
    && await saveViaPostgres([{ collection: "customers", id, type: "merge", data }])) {
    return;
  }
  await setDoc(doc(db, "customers", id), data, { merge: true });
}

async function removeCustomer(id) {
  if (savesToPostgres("customers")
    && await saveViaPostgres([{ collection: "customers", id, type: "delete" }])) {
    return;
  }
  const { db } = await getFirebase();
  await deleteDoc(doc(db, "customers", id));
}

export async function saveCustomerDoc(customer) {
  const { db } = await getFirebase();
  const id = customer.id || doc(collection(db, "customers")).id;
  const data = { ...customer, id };
  await withJournal(`customers/${id}`, { type: "customerSave", id, data }, async () => {
    await ensureFirebaseAuth();
    await writeCustomer(id, data);
  });
  return id;
}

// Money on a customer's account. Positive is credit the shop owes them,
// negative is a tab they owe the shop. Two tills can be serving the same
// customer at once, so the read and the write are one transaction — otherwise
// the second one to save would overwrite the first one's balance.
export async function adjustCustomerBalance(customerId, { amount, reason, by, kind }) {
  const delta = Math.round((Number(amount) || 0) * 100) / 100;
  if (!customerId || !delta) return null;
  const change = { type: "balance", customerId, amount: delta, reason, by, kind, entryId: crypto.randomUUID() };
  return withJournal(`balance/${change.entryId}`, change, async () => {
    await ensureFirebaseAuth();
    return applyBalanceChange(change);
  });
}

// One entry id for the life of the change. The server answers a repeat with
// what it already did, and the Firestore way below looks for it on the
// customer before adding anything, so an answer that never arrived (the
// change made, the reply lost) cannot take the money twice.
async function applyBalanceChange({ customerId, amount: delta, reason, by, kind, entryId }) {
  if (savesToPostgres("balances")) {
    try {
      return await callFunction("adjustCustomerBalance", {
        customerId, amount: delta, reason, by, kind, entryId,
      });
    } catch (error) {
      if (FINAL_ERRORS.has(error?.code)) {
        const refused = new Error(error.message || "That balance change was refused.");
        refused.final = true;
        throw refused;
      }
      console.warn("Diamant Telecom: PostgreSQL balance change did not go through, using Firestore instead.", error);
    }
  }
  const { db } = await getFirebase();
  const ref = doc(db, "customers", customerId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      const gone = new Error("That customer is no longer in the CRM.");
      gone.final = true;
      throw gone;
    }
    const current = Math.round((Number(snap.data().balance) || 0) * 100) / 100;
    const already = (snap.data().balanceEntries || []).find((item) => item?.id === entryId);
    if (already) return { balance: current, entry: already, repeated: true };
    const balance = Math.round((current + delta) * 100) / 100;
    const entry = {
      id: entryId,
      at: new Date().toISOString(),
      by: by || "",
      kind: kind || (delta > 0 ? "Credit added" : "Credit used"),
      reason: String(reason || "").trim(),
      amount: delta.toFixed(2),
      balanceAfter: balance.toFixed(2),
    };
    // Only the recent history is kept on the customer: enough to settle an
    // argument at the counter without letting one document grow forever.
    const history = [entry, ...(snap.data().balanceEntries || [])].slice(0, 50);
    tx.set(ref, { balance, balanceEntries: history, balanceUpdatedAt: entry.at }, { merge: true });
    return { balance, entry };
  });
}

export async function deleteCustomerDoc(id) {
  if (!id) return;
  await withJournal(`customers/${id}`, { type: "customerDelete", id }, async () => {
    await ensureFirebaseAuth();
    await removeCustomer(id);
  });
}
