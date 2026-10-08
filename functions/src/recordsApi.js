// Writes the Firestore copy for the record store and handles the register
// calls. Kept apart from index.js so the pieces can be tested with fakes.

const crypto = require("node:crypto");
const {
  SaveRefused,
  adjustBalance,
  compareWithFirestore,
  ensureRecordSchema,
  saveRecords,
  seedCollection,
} = require("./recordStore");

// Firestore batches hold at most 500 writes.
const BATCH_LIMIT = 450;

function firestoreMirror(db) {
  return async (changes) => {
    const times = [];
    for (let start = 0; start < changes.length; start += BATCH_LIMIT) {
      const batch = db.batch();
      const chunk = changes.slice(start, start + BATCH_LIMIT);
      for (const change of chunk) {
        const ref = db.collection(change.collection).doc(change.id);
        if (change.type === "delete") batch.delete(ref);
        else if (change.type === "merge" || change.collection === "products") batch.set(ref, change.data, { merge: true });
        else batch.set(ref, change.data);
      }
      const results = await batch.commit();
      results.forEach((result) => times.push(result.writeTime.toDate().toISOString()));
    }
    return times;
  };
}

function authOf(request) {
  const token = request.auth?.token || {};
  return { uid: request.auth?.uid || "", admin: token.role === "admin" || token.admin === true };
}

// Errors the register should fall back on (the database could not be
// reached) are kept apart from refusals it must not retry another way.
function toCallError(HttpsError, error) {
  if (error instanceof SaveRefused) return new HttpsError(error.code, error.message);
  if (/not valid|Unknown collection|Nothing to save|at most|has no data/.test(error.message || "")) {
    return new HttpsError("invalid-argument", error.message);
  }
  return new HttpsError("unavailable", "The database could not be reached. The save will go the usual way.");
}

async function handleSaveRecords({ request, db, pool, HttpsError, logger }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  try {
    return await saveRecords(pool, request.data?.ops, { auth: authOf(request), mirror: firestoreMirror(db) });
  } catch (error) {
    if (!(error instanceof SaveRefused)) logger.error("saveRecords failed", { error: error.message || String(error) });
    throw toCallError(HttpsError, error);
  }
}

async function handleAdjustBalance({ request, db, pool, HttpsError, logger }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const input = request.data || {};
  const entryId = /^[A-Za-z0-9-]{8,80}$/.test(String(input.entryId || "")) ? input.entryId : crypto.randomUUID();
  try {
    return await adjustBalance(pool, {
      customerId: String(input.customerId || ""),
      amount: input.amount,
      reason: input.reason,
      by: input.by,
      kind: input.kind,
      entryId,
      at: new Date().toISOString(),
    }, { auth: authOf(request), mirror: firestoreMirror(db) });
  } catch (error) {
    if (!(error instanceof SaveRefused)) logger.error("adjustCustomerBalance failed", { error: error.message || String(error) });
    throw toCallError(HttpsError, error);
  }
}

function docsOf(snapshot) {
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    updateTime: doc.updateTime ? doc.updateTime.toDate().toISOString() : null,
  }));
}

// Fills any record PostgreSQL does not have yet, then compares every
// collection. Nothing in Firestore is changed.
async function runRecordsCheck({ db, pool }) {
  await ensureRecordSchema(pool);
  const collections = (await db.listCollections()).map((ref) => ref.id).sort();
  const summary = { at: new Date().toISOString(), collections: {}, problems: [] };
  for (const collection of collections) {
    const docs = docsOf(await db.collection(collection).get());
    const filled = await seedCollection(pool, collection, docs);
    const check = await compareWithFirestore(pool, collection, docs);
    summary.collections[collection] = {
      firestore: check.firestore,
      postgres: check.postgres,
      filled,
      different: check.different.length,
      onlyInFirestore: check.onlyInFirestore.length,
      onlyInPostgres: check.onlyInPostgres.length,
    };
    if (check.different.length || check.onlyInFirestore.length || check.onlyInPostgres.length) {
      summary.problems.push({
        collection,
        different: check.different.slice(0, 20),
        onlyInFirestore: check.onlyInFirestore.slice(0, 20),
        onlyInPostgres: check.onlyInPostgres.slice(0, 20),
      });
    }
  }
  summary.ok = summary.problems.length === 0;
  return summary;
}

module.exports = {
  authOf,
  firestoreMirror,
  handleAdjustBalance,
  handleSaveRecords,
  runRecordsCheck,
  toCallError,
};
