import { useEffect, useRef, useState } from "react";
import {
  deleteCollectionItems,
  logSyncError,
  replaceAppStateDocument,
  syncCollectionItems,
  upsertCollectionItems,
  watchAppStateDocument,
  watchCollection,
} from "../firebaseClient";
import {
  ensureArrayIds,
  isSameArray,
  readJson,
  sortCloudItems,
} from "../utils";

export function useStoredState(key, fallback) {
  const [value, setValue] = useState(() => readJson(key, fallback));

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

// ---- Sync outbox -----------------------------------------------------------
//
// A write used to be dropped on the floor in two situations: the Firestore
// listener had not delivered its first snapshot yet (cloudReady still false), or
// the write rejected and we only logged it. Either way the register kept the row
// in localStorage and nobody else ever saw it — which is how a card could be
// charged and the sale never turn up in reports.
//
// Every change now lands in a localStorage-backed outbox first and is only
// cleared once Firestore confirms it, so a completed sale survives a blocked
// network, a closed tab, and a reboot, and replays when the cloud comes back.

const OUTBOX_SUFFIX = "::outbox";
// How often to retry while anything is still waiting.
const OUTBOX_RETRY_MS = 15000;

function readOutbox(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key + OUTBOX_SUFFIX) || "null");
    if (!raw || typeof raw !== "object") return { upserts: {}, deletes: [] };
    return {
      upserts: raw.upserts && typeof raw.upserts === "object" ? raw.upserts : {},
      deletes: Array.isArray(raw.deletes) ? raw.deletes : [],
    };
  } catch {
    return { upserts: {}, deletes: [] };
  }
}

function writeOutbox(key, outbox) {
  try {
    if (!Object.keys(outbox.upserts).length && !outbox.deletes.length) {
      localStorage.removeItem(key + OUTBOX_SUFFIX);
      return;
    }
    localStorage.setItem(key + OUTBOX_SUFFIX, JSON.stringify(outbox));
  } catch (error) {
    // Out of quota is the realistic failure here. Log loudly: this is the one
    // place where losing the record is possible.
    console.error(`Could not persist pending ${key} writes`, error);
  }
}

// Entries whose save is still on its way are on disk (so a reload replays them)
// but are not counted as stuck until that save has actually failed.
function outboxSize(outbox, inFlight) {
  if (!inFlight) return Object.keys(outbox.upserts).length + outbox.deletes.length;
  const upserts = Object.entries(outbox.upserts).filter(([id, item]) => inFlight.upserts.get(id) !== item).length;
  const deletes = outbox.deletes.filter((id) => !inFlight.deletes.has(id)).length;
  return upserts + deletes;
}

// A save through PostgreSQL reaches Firestore from the server, a moment after
// it is confirmed, so the cloud can still send the old copy in between. The
// saved copy is held over the cloud's until the cloud catches up.
const HOLD_MS = 8000;

function stableText(value) {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function applyHolds(holds, items) {
  if (!holds.size) return items;
  const now = Date.now();
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const [id, hold] of holds) {
    const cloud = byId.get(id);
    const caughtUp = hold.item === null ? !cloud : cloud && stableText(cloud) === stableText(hold.item);
    if (hold.until < now || caughtUp) holds.delete(id);
  }
  if (!holds.size) return items;
  const held = [...holds.entries()];
  return [
    ...items.filter((item) => !holds.has(item.id)),
    ...held.filter(([, hold]) => hold.item !== null).map(([, hold]) => hold.item),
  ];
}

// Which documents actually changed between two versions of the collection.
function diffItems(previousItems, nextItems) {
  const previousById = new Map(previousItems.map((item) => [item.id, item]));
  const nextIds = new Set(nextItems.map((item) => item.id));
  const changed = nextItems.filter((item) => {
    const previous = previousById.get(item.id);
    return !previous || JSON.stringify(previous) !== JSON.stringify(item);
  });
  const removed = [...previousById.keys()].filter((id) => !nextIds.has(id));
  return { changed, removed };
}

export function useCloudCollectionState(collectionName, localKey, fallback, options = {}) {
  const enabled = options.enabled !== false;
  const [value, setValue] = useState(() => ensureArrayIds(readJson(localKey, fallback)));
  const valueRef = useRef(value);
  const cloudReadyRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const pendingWritesRef = useRef(0);
  // Anything written while the cloud was unreachable, replayed on reconnect.
  // Read lazily: useRef evaluates its argument on every render, and this is a
  // register that re-renders on every keystroke.
  const outboxRef = useRef(null);
  if (outboxRef.current === null) outboxRef.current = readOutbox(localKey);
  const flushingRef = useRef(false);
  const holdsRef = useRef(new Map());
  // Changes handed to the server and not yet answered: id -> the item sent, and
  // id -> how many removals of it are on their way.
  const inFlightRef = useRef(null);
  if (inFlightRef.current === null) inFlightRef.current = { upserts: new Map(), deletes: new Map() };
  const [pendingCount, setPendingCount] = useState(() => outboxSize(outboxRef.current));

  function holdSaved(where, changed, removed) {
    if (where !== "postgres") return;
    const until = Date.now() + HOLD_MS;
    changed.forEach((item) => { if (item?.id) holdsRef.current.set(item.id, { item, until }); });
    removed.forEach((id) => holdsRef.current.set(id, { item: null, until }));
  }

  useEffect(() => {
    valueRef.current = value;
    localStorage.setItem(localKey, JSON.stringify(value));
  }, [localKey, value]);

  function persistOutbox() {
    writeOutbox(localKey, outboxRef.current);
    setPendingCount(outboxSize(outboxRef.current, inFlightRef.current));
  }

  function markInFlight(changed, removed) {
    const inFlight = inFlightRef.current;
    changed.forEach((item) => { if (item?.id) inFlight.upserts.set(item.id, item); });
    removed.forEach((id) => inFlight.deletes.set(id, (inFlight.deletes.get(id) || 0) + 1));
  }

  function releaseInFlight(changed, removed) {
    const inFlight = inFlightRef.current;
    changed.forEach((item) => {
      if (item?.id && inFlight.upserts.get(item.id) === item) inFlight.upserts.delete(item.id);
    });
    removed.forEach((id) => {
      const left = (inFlight.deletes.get(id) || 0) - 1;
      if (left > 0) inFlight.deletes.set(id, left);
      else inFlight.deletes.delete(id);
    });
  }

  // The server confirmed these. Clear only what is still exactly what was
  // sent; anything changed again since stays owed.
  function clearConfirmed(changed, removed) {
    const outbox = outboxRef.current;
    changed.forEach((item) => {
      if (item?.id && outbox.upserts[item.id] === item) delete outbox.upserts[item.id];
    });
    outbox.deletes = outbox.deletes.filter((id) => !removed.includes(id) || inFlightRef.current.deletes.has(id));
  }

  // Queue a change for replay. An id that is being deleted drops any pending
  // upsert for the same document, and vice versa, so the outbox can't fight
  // itself and resurrect a deleted row.
  function queueChanges(changed, removed) {
    const outbox = outboxRef.current;
    changed.forEach((item) => {
      if (!item?.id) return;
      outbox.upserts[item.id] = item;
      outbox.deletes = outbox.deletes.filter((id) => id !== item.id);
    });
    removed.forEach((id) => {
      delete outbox.upserts[id];
      if (!outbox.deletes.includes(id)) outbox.deletes.push(id);
    });
    persistOutbox();
  }

  // Replay the outbox. Only entries confirmed written are cleared; anything that
  // fails (or arrives while we were mid-flight) stays queued for the next try.
  async function flushOutbox() {
    if (flushingRef.current || !cloudReadyRef.current) return;
    const outbox = outboxRef.current;
    const inFlight = inFlightRef.current;
    // A save already on its way is left to answer for itself.
    const upserts = Object.values(outbox.upserts).filter((item) => inFlight.upserts.get(item.id) !== item);
    const deletes = outbox.deletes.filter((id) => !inFlight.deletes.has(id));
    if (!upserts.length && !deletes.length) return;

    flushingRef.current = true;
    pendingWritesRef.current += 1;
    try {
      if (upserts.length) holdSaved(await upsertCollectionItems(collectionName, upserts), upserts, []);
      if (deletes.length) holdSaved(await deleteCollectionItems(collectionName, deletes), [], deletes);
      upserts.forEach((item) => {
        // Only clear if nothing newer was queued for this id while we were away.
        if (outbox.upserts[item.id] === item) delete outbox.upserts[item.id];
      });
      outbox.deletes = outbox.deletes.filter((id) => !deletes.includes(id) || inFlight.deletes.has(id));
      persistOutbox();
    } catch (error) {
      logSyncError(`Firestore ${collectionName} retry failed`, error);
    } finally {
      pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
      flushingRef.current = false;
    }
  }

  // Retry on a timer and whenever the browser says the network is back. The
  // timer only runs while something is actually waiting.
  useEffect(() => {
    if (!enabled || !pendingCount) return undefined;
    const timer = window.setInterval(() => { flushOutbox(); }, OUTBOX_RETRY_MS);
    const onOnline = () => { flushOutbox(); };
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, pendingCount, collectionName]);

  useEffect(() => {
    if (!enabled) return undefined;
    return watchCollection(
      collectionName,
      (items) => {
        cloudReadyRef.current = true;
        // The listener answering is the proof that Firestore is reachable, so
        // this is the moment to replay anything stranded by an earlier outage.
        flushOutbox();
        if (!items.length && valueRef.current.length && !saveQueuedRef.current) {
          saveQueuedRef.current = true;
          upsertCollectionItems(collectionName, valueRef.current)
            .catch((error) => {
              saveQueuedRef.current = false;
              logSyncError(`Firestore ${collectionName} bootstrap failed`, error);
            });
          return;
        }
        if (pendingWritesRef.current > 0) return;
        // A repair saved on this computer and still waiting to upload must not
        // be thrown away because a cloud snapshot has not heard about it yet.
        // That snapshot is how a labeled ticket disappeared while the customer
        // was still holding the number.
        const pendingById = outboxRef.current.upserts;
        const deleted = new Set(outboxRef.current.deletes);
        const dropped = valueRef.current.filter((item) =>
          item?.id && !items.some((cloud) => cloud.id === item.id) && !pendingById[item.id]);
        if (dropped.length) {
          console.warn(
            `Diamant Telecom: ${dropped.length} ${collectionName} row(s) exist only on this computer ` +
              `and are being replaced by the cloud copy.`,
            dropped,
          );
        }
        const merged = [
          ...applyHolds(holdsRef.current, items).filter((item) => item?.id && !pendingById[item.id] && !deleted.has(item.id)),
          ...Object.values(pendingById),
        ];
        const sorted = sortCloudItems(merged);
        // Skip no-op updates (e.g. metadata-only snapshots) so we don't churn
        // identity and re-run downstream effects that can trigger more writes.
        if (!isSameArray(sorted, valueRef.current)) setValue(sorted);
      },
      (error) => {
        logSyncError(`Firestore ${collectionName} sync failed`, error);
      },
      { ...options, cacheKey: localKey },
    );
  }, [collectionName, enabled]);

  function updateValue(nextValueOrUpdater, options = {}) {
    setValue((current) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;
      const normalized = ensureArrayIds(nextValue);

      if (!options.localOnly) {
        const { changed, removed } = diffItems(current, normalized);
        if (changed.length || removed.length) {
          if (!cloudReadyRef.current) {
            // No confirmed connection yet — bank it rather than lose it.
            queueChanges(changed, removed);
          } else {
            // On disk before it goes anywhere: a server call that is still
            // waking up keeps nothing if the page is closed or reloaded, so
            // the outbox holds it until the save is confirmed.
            markInFlight(changed, removed);
            queueChanges(changed, removed);
            pendingWritesRef.current += 1;
            syncCollectionItems(collectionName, current, normalized)
              .then((where) => {
                holdSaved(where, changed, removed);
                releaseInFlight(changed, removed);
                clearConfirmed(changed, removed);
                persistOutbox();
              })
              .catch((error) => {
                logSyncError(`Firestore ${collectionName} sync failed`, error);
                // The write failed, so it is still owed. It is already in the
                // outbox; the retry loop carries it until it is accepted.
                releaseInFlight(changed, removed);
                persistOutbox();
              })
              .finally(() => {
                pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
              });
          }
        }
      }

      return normalized;
    });
  }

  return [value, updateValue, pendingCount];
}

// `options.merge(localValue, cloudValue)` lets a caller reconcile a fresh cloud
// read with the local value instead of blindly trusting the cloud. The default
// trusts the cloud (last-write-wins). The employees list passes a union merge so
// a register holding a shorter list can never drop names another register added.
const trustCloud = (_local, cloud) => cloud;

// The document version this computer saved and has not seen confirmed. Kept on
// disk so a reload while the server was still waking up sends it again instead
// of letting the older cloud copy replace it.
const PENDING_SUFFIX = "::pending";
const PENDING_RETRY_MS = 15000;

function readPendingDocument(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key + PENDING_SUFFIX) || "null");
    return raw && typeof raw === "object" && "items" in raw ? raw : null;
  } catch {
    return null;
  }
}

function writePendingDocument(key, entry) {
  try {
    if (entry) localStorage.setItem(key + PENDING_SUFFIX, JSON.stringify(entry));
    else localStorage.removeItem(key + PENDING_SUFFIX);
  } catch (error) {
    console.error(`Could not keep the pending ${key} save on this computer`, error);
  }
}

export function useCloudDocumentState(documentId, localKey, fallback, options = {}) {
  const merge = options.merge || trustCloud;
  const [value, setValue] = useState(() => readJson(localKey, fallback));
  const valueRef = useRef(value);
  // `fallback` is often an inline literal (a new array every render); pin it once
  // so the watch effect below depends only on `documentId` and doesn't tear down
  // and re-subscribe its Firestore listener on every render.
  const fallbackRef = useRef(fallback);
  const mergeRef = useRef(merge);
  mergeRef.current = merge;
  const cloudReadyRef = useRef(false);
  const bootstrappedRef = useRef(false);
  // The last value we pushed to the cloud, so an echo of our own write (or a
  // stable shape difference the merge keeps re-producing) can't make us heal the
  // same value over and over — a self-sustaining write/read loop across devices.
  const lastPushedRef = useRef(null);
  const pendingRef = useRef(undefined);
  if (pendingRef.current === undefined) pendingRef.current = readPendingDocument(localKey);
  const pushesRef = useRef(0);
  const retryTimerRef = useRef(null);

  useEffect(() => {
    valueRef.current = value;
    localStorage.setItem(localKey, JSON.stringify(value));
  }, [localKey, value]);

  useEffect(() => () => {
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
  }, []);

  function clearPending(entry) {
    if (pendingRef.current !== entry) return;
    pendingRef.current = null;
    writePendingDocument(localKey, null);
  }

  // Written to disk first, cleared once the cloud has it, and sent again on a
  // timer (and on the next snapshot) until it does.
  function pushPending(entry) {
    pushesRef.current += 1;
    replaceAppStateDocument(documentId, entry.items)
      .then(() => clearPending(entry))
      .catch((error) => {
        logSyncError(`Firestore appState/${documentId} sync failed`, error);
        if (pendingRef.current !== entry || retryTimerRef.current) return;
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (pendingRef.current && !pushesRef.current) pushPending(pendingRef.current);
        }, PENDING_RETRY_MS);
      })
      .finally(() => {
        pushesRef.current = Math.max(0, pushesRef.current - 1);
      });
  }

  useEffect(() => {
    return watchAppStateDocument(
      documentId,
      fallbackRef.current,
      (items) => {
        cloudReadyRef.current = true;
        const pending = pendingRef.current;
        if (pending) {
          if (stableText(items) === stableText(pending.items)) {
            clearPending(pending);
          } else {
            // The cloud has not caught up with this computer's save yet. Keep
            // showing it and make sure it is on its way.
            if (!pushesRef.current) pushPending(pending);
            return;
          }
        }
        const cloudIsEmpty = isSameArray(items, fallbackRef.current);
        const localHasData = !isSameArray(valueRef.current, fallbackRef.current);

        // The cloud has nothing yet but this device does: seed the cloud from
        // local once, and keep showing the local data. Critically we NEVER fall
        // through to `setValue(items)` here, so an empty cloud read can never
        // blank out (and then overwrite localStorage with) populated local data.
        if (cloudIsEmpty && localHasData) {
          if (!bootstrappedRef.current) {
            bootstrappedRef.current = true;
            replaceAppStateDocument(documentId, valueRef.current).catch((error) => {
              bootstrappedRef.current = false;
              logSyncError(`Firestore appState/${documentId} sync failed`, error);
            });
          }
          return;
        }

        const merged = mergeRef.current(valueRef.current, items);
        // Only re-render when the content actually changed — a new array with the
        // same content still churns identity and re-runs downstream effects.
        if (!isSameArray(merged, valueRef.current)) setValue(merged);
        // If the merge recovered entries the cloud was missing, heal the cloud so
        // every other device converges on the union instead of the shorter list —
        // but never re-push a value we already pushed (breaks the loop).
        if (!isSameArray(merged, items) && !isSameArray(merged, lastPushedRef.current)) {
          lastPushedRef.current = merged;
          replaceAppStateDocument(documentId, merged).catch((error) =>
            logSyncError(`Firestore appState/${documentId} sync failed`, error),
          );
        }
      },
      (error) => {
        logSyncError(`Firestore appState/${documentId} sync failed`, error);
      },
      { onCache: () => { cloudReadyRef.current = true; } },
    );
  }, [documentId]);

  function updateValue(nextValueOrUpdater) {
    setValue((current) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;

      // Writing an identical value is what let a heal/merge fight rewrite
      // appState/staff thousands of times: return the same reference so we neither
      // re-render nor push a no-op write.
      if (isSameArray(nextValue, current)) return current;

      if (cloudReadyRef.current) {
        lastPushedRef.current = nextValue;
        const entry = { items: nextValue };
        pendingRef.current = entry;
        writePendingDocument(localKey, entry);
        pushPending(entry);
      }

      return nextValue;
    });
  }

  return [value, updateValue];
}
