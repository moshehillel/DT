import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { normalizeFirestoreDoc } from "./utils";

let firebasePromise;
let authPromise;

async function getFirebase() {
  if (!firebasePromise) {
    firebasePromise = fetch("/__/firebase/init.json")
      .then((response) => {
        if (!response.ok) throw new Error("Firebase hosting config is not available.");
        return response.json();
      })
      .then((firebaseConfig) => {
        const app = initializeApp(firebaseConfig);
        return {
          auth: getAuth(app),
          db: getFirestore(app),
        };
      });
  }

  return firebasePromise;
}

export async function ensureFirebaseAuth() {
  const { auth } = await getFirebase();

  if (!authPromise) {
    authPromise = auth.currentUser
      ? Promise.resolve(auth.currentUser)
      : signInAnonymously(auth).then((credential) => credential.user);
  }

  return authPromise;
}

export async function attachAuthMetadata(data) {
  try {
    const user = await ensureFirebaseAuth();
    return {
      ...data,
      servedByEmployeeId: user?.uid || data.servedByEmployeeId || "",
    };
  } catch {
    return data;
  }
}

export function watchCollection(collectionName, onItems, onError) {
  let unsubscribe = () => {};
  let cancelled = false;

  ensureFirebaseAuth()
    .then(() => getFirebase())
    .then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, collectionName),
        (snapshot) => {
          onItems(snapshot.docs.map((item) => normalizeFirestoreDoc(item.id, item.data())));
        },
        onError,
      );
    })
    .catch(onError);

  return () => {
    cancelled = true;
    unsubscribe();
  };
}

export function watchAppStateDocument(documentId, fallback, onValue, onError) {
  let unsubscribe = () => {};
  let cancelled = false;

  ensureFirebaseAuth()
    .then(() => getFirebase())
    .then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "appState", documentId),
        (snapshot) => {
          onValue(snapshot.exists() ? snapshot.data().items || fallback : fallback);
        },
        onError,
      );
    })
    .catch(onError);

  return () => {
    cancelled = true;
    unsubscribe();
  };
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

export async function upsertCollectionItems(collectionName, items) {
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);

  await commitBatches(
    db,
    items.map((item) => (batch) => batch.set(doc(collectionRef, item.id), item)),
  );
}

export async function syncCollectionItems(collectionName, previousItems, nextItems) {
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);
  const previousIds = new Set(previousItems.map((item) => item.id));
  const nextIds = new Set(nextItems.map((item) => item.id));
  const operations = [
    ...nextItems.map((item) => (batch) => batch.set(doc(collectionRef, item.id), item)),
    ...[...previousIds]
      .filter((id) => !nextIds.has(id))
      .map((id) => (batch) => batch.delete(doc(collectionRef, id))),
  ];

  if (!operations.length) return;
  await commitBatches(db, operations);
}

export async function replaceAppStateDocument(documentId, items) {
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  await setDoc(doc(db, "appState", documentId), { items });
}
