import { useEffect, useRef, useState } from "react";
import {
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

export function useCloudCollectionState(collectionName, localKey, fallback) {
  const [value, setValue] = useState(() => ensureArrayIds(readJson(localKey, fallback)));
  const valueRef = useRef(value);
  const cloudReadyRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const pendingWritesRef = useRef(0);

  useEffect(() => {
    valueRef.current = value;
    localStorage.setItem(localKey, JSON.stringify(value));
  }, [localKey, value]);

  useEffect(() => {
    return watchCollection(
      collectionName,
      (items) => {
        cloudReadyRef.current = true;
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
        setValue(sortCloudItems(items));
      },
      (error) => {
        logSyncError(`Firestore ${collectionName} sync failed`, error);
      },
    );
  }, [collectionName]);

  function updateValue(nextValueOrUpdater, options = {}) {
    setValue((current) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;
      const normalized = ensureArrayIds(nextValue);

      if (cloudReadyRef.current && !options.localOnly) {
        pendingWritesRef.current += 1;
        syncCollectionItems(collectionName, current, normalized)
          .catch((error) => {
            logSyncError(`Firestore ${collectionName} sync failed`, error);
          })
          .finally(() => {
            pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
          });
      }

      return normalized;
    });
  }

  return [value, updateValue];
}

// `options.merge(localValue, cloudValue)` lets a caller reconcile a fresh cloud
// read with the local value instead of blindly trusting the cloud. The default
// trusts the cloud (last-write-wins). The employees list passes a union merge so
// a register holding a shorter list can never drop names another register added.
const trustCloud = (_local, cloud) => cloud;

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

  useEffect(() => {
    valueRef.current = value;
    localStorage.setItem(localKey, JSON.stringify(value));
  }, [localKey, value]);

  useEffect(() => {
    return watchAppStateDocument(
      documentId,
      fallbackRef.current,
      (items) => {
        cloudReadyRef.current = true;
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
        setValue(merged);
        // If the merge recovered entries the cloud was missing, heal the cloud so
        // every other device converges on the union instead of the shorter list.
        if (!isSameArray(merged, items)) {
          replaceAppStateDocument(documentId, merged).catch((error) =>
            logSyncError(`Firestore appState/${documentId} sync failed`, error),
          );
        }
      },
      (error) => {
        logSyncError(`Firestore appState/${documentId} sync failed`, error);
      },
    );
  }, [documentId]);

  function updateValue(nextValueOrUpdater) {
    setValue((current) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;

      if (cloudReadyRef.current) {
        replaceAppStateDocument(documentId, nextValue).catch((error) =>
          logSyncError(`Firestore appState/${documentId} sync failed`, error),
        );
      }

      return nextValue;
    });
  }

  return [value, updateValue];
}
