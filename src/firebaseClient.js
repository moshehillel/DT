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

const firebaseConfig = {
  apiKey: "AIzaSyCisNj4Pyx7_1wAJO-1ueF6RnY6nAwc9WE",
  authDomain: "diamant-telecom.firebaseapp.com",
  projectId: "diamant-telecom",
  storageBucket: "diamant-telecom.firebasestorage.app",
  messagingSenderId: "287927197394",
  appId: "1:287927197394:web:8c7db402503d31fe04570b",
  measurementId: "G-8CTHDQX1LD",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
export const db = getFirestore(app);

let authPromise;

export function ensureFirebaseAuth() {
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
    .then(() => {
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
    .then(() => {
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
  await setDoc(doc(db, "appState", documentId), { items });
}
