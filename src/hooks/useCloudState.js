import { useEffect, useRef, useState } from "react";
import {
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
          upsertCollectionItems(collectionName, valueRef.current).catch(console.error);
          return;
        }
        setValue(sortCloudItems(items));
      },
      (error) => {
        console.error(`Firestore ${collectionName} sync failed`, error);
      },
    );
  }, [collectionName]);

  function updateValue(nextValueOrUpdater) {
    setValue((current) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;
      const normalized = ensureArrayIds(nextValue);

      if (cloudReadyRef.current) {
        syncCollectionItems(collectionName, current, normalized).catch(console.error);
      }

      return normalized;
    });
  }

  return [value, updateValue];
}

export function useCloudDocumentState(documentId, localKey, fallback) {
  const [value, setValue] = useState(() => readJson(localKey, fallback));
  const valueRef = useRef(value);
  const cloudReadyRef = useRef(false);
  const saveQueuedRef = useRef(false);

  useEffect(() => {
    valueRef.current = value;
    localStorage.setItem(localKey, JSON.stringify(value));
  }, [localKey, value]);

  useEffect(() => {
    return watchAppStateDocument(
      documentId,
      fallback,
      (items) => {
        cloudReadyRef.current = true;
        if (isSameArray(items, fallback) && !isSameArray(valueRef.current, fallback) && !saveQueuedRef.current) {
          saveQueuedRef.current = true;
          replaceAppStateDocument(documentId, valueRef.current).catch(console.error);
          return;
        }
        setValue(items);
      },
      (error) => {
        console.error(`Firestore appState/${documentId} sync failed`, error);
      },
    );
  }, [documentId, fallback]);

  function updateValue(nextValueOrUpdater) {
    setValue((current) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(current)
        : nextValueOrUpdater;

      if (cloudReadyRef.current) {
        replaceAppStateDocument(documentId, nextValue).catch(console.error);
      }

      return nextValue;
    });
  }

  return [value, updateValue];
}
