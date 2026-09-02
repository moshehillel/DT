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
  setDoc,
  startAfter,
  where,
  writeBatch,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { normalizeFirestoreDoc } from "./utils";

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

// Calls an admin-only Cloud Function (callable) such as employee management.
export async function callFunction(name, data) {
  const { functions } = await getFirebase();
  const callable = httpsCallable(functions, name);
  const result = await callable(data || {});
  return result.data;
}

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
  const number = String(ticketNumber || "").trim();
  if (!number) return "unconfirmed";

  let ticketRef;
  try {
    const { db } = await getFirebase();
    ticketRef = doc(db, "repairTickets", number);
    const existing = await withClaimTimeout(getDoc(ticketRef));
    if (existing === CLAIM_TIMEOUT) return "unconfirmed";
    if (existing.exists()) return "taken";
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
    if (error?.code === "permission-denied") return "taken";
    logSyncError("Firestore repair ticket claim failed", error);
    return "unconfirmed";
  }
}

// `options.limitTo` caps the live listener to the N most recent docs (ordered by
// `options.orderByField`, default "createdAt", descending) so large collections
// like notificationLogs don't re-read their whole history on every load.
export function watchCollection(collectionName, onItems, onError, options = {}) {
  let unsubscribe = () => {};
  let cancelled = false;

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

export function watchAppStateDocument(documentId, fallback, onValue, onError) {
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

// Removes specific documents by id. Used by the sync outbox when it replays a
// deletion that couldn't reach Firestore at the time it was made.
export async function deleteCollectionItems(collectionName, ids) {
  if (!ids.length) return;
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);

  await commitBatches(
    db,
    ids.map((id) => (batch) => batch.delete(doc(collectionRef, id))),
  );
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
  const { db } = await getFirebase();
  const collectionRef = collection(db, collectionName);
  const previousById = new Map(previousItems.map((item) => [item.id, item]));
  const nextIds = new Set(nextItems.map((item) => item.id));
  const operations = [
    // Only write docs that are new or whose contents actually changed, so editing
    // one item in a large collection doesn't rewrite every document.
    ...nextItems
      .filter((item) => {
        const previous = previousById.get(item.id);
        return !previous || stableStringify(previous) !== stableStringify(item);
      })
      .map((item) => (batch) => batch.set(doc(collectionRef, item.id), item)),
    ...[...previousById.keys()]
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

// ---- Customers: query on demand instead of loading the whole collection ----

function toDoc(snap) {
  return normalizeFirestoreDoc(snap.id, snap.data());
}

// Exact lookup by the local 10-digit number — tries phoneDigits then mobileDigits.
export async function findCustomerByPhone(digits) {
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

export async function saveCustomerDoc(customer) {
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  const id = customer.id || doc(collection(db, "customers")).id;
  await setDoc(doc(db, "customers", id), { ...customer, id });
  return id;
}

export async function deleteCustomerDoc(id) {
  if (!id) return;
  await ensureFirebaseAuth();
  const { db } = await getFirebase();
  await deleteDoc(doc(db, "customers", id));
}
