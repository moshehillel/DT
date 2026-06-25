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
  doc,
  getFirestore,
  onSnapshot,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { normalizeFirestoreDoc } from "./utils";

let firebasePromise;

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
          db: getFirestore(app),
          functions: getFunctions(app),
        };
      });
  }

  return firebasePromise;
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

// Calls an admin-only Cloud Function (callable) such as employee management.
export async function callFunction(name, data) {
  const { functions } = await getFirebase();
  const callable = httpsCallable(functions, name);
  const result = await callable(data || {});
  return result.data;
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
