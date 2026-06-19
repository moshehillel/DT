import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  setDoc,
} from "firebase/firestore";

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
          onItems(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
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

export async function replaceCollection(collectionName, items) {
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);
  const existing = await getDocs(collectionRef);
  const nextIds = new Set(items.map((item) => item.id));

  await Promise.all([
    ...items.map((item) => setDoc(doc(collectionRef, item.id), item)),
    ...existing.docs
      .filter((item) => !nextIds.has(item.id))
      .map((item) => deleteDoc(item.ref)),
  ]);
}

export async function replaceAppStateDocument(documentId, items) {
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  await setDoc(doc(db, "appState", documentId), { items });
}
