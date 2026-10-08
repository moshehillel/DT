const { compareCollection, fingerprintOf, toRow } = require("./pgMirror");

const SCHEMA = `
create table if not exists fs_documents (
  collection text not null,
  id text not null,
  data jsonb not null,
  fingerprint text not null,
  fs_update_time timestamptz,
  doc_type text,
  created_at timestamptz,
  location text,
  customer_phone text,
  amount numeric(14, 2),
  first_copied_at timestamptz not null default now(),
  last_copied_at timestamptz not null default now(),
  missing_since timestamptz,
  primary key (collection, id)
);
create index if not exists fs_documents_type_idx on fs_documents (collection, doc_type, created_at);
create index if not exists fs_documents_phone_idx on fs_documents (customer_phone);
create index if not exists fs_documents_location_idx on fs_documents (collection, location, created_at);

create table if not exists sync_runs (
  id bigserial primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  ok boolean,
  summary jsonb
);
`;

const BATCH = 200;

function viewName(collection) {
  const safe = collection.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  return `fs_${safe}`.slice(0, 60);
}

async function ensureSchema(pool, collections) {
  await pool.query(SCHEMA);
  for (const collection of collections) {
    const name = viewName(collection);
    const literal = collection.replace(/'/g, "''");
    await pool.query(
      `create or replace view ${name} as
         select id, data, doc_type, created_at, location, customer_phone, amount,
                fs_update_time, first_copied_at, last_copied_at, missing_since
         from fs_documents where collection = '${literal}'`,
    );
  }
}

async function upsertRows(pool, rows) {
  for (let index = 0; index < rows.length; index += BATCH) {
    const chunk = rows.slice(index, index + BATCH);
    const values = [];
    const params = [];
    chunk.forEach((row, rowIndex) => {
      const base = rowIndex * 10;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}, $${base + 5}::timestamptz, $${base + 6}, $${base + 7}::timestamptz, $${base + 8}, $${base + 9}, $${base + 10}::numeric)`);
      params.push(
        row.collection,
        row.id,
        JSON.stringify(row.data),
        row.fingerprint,
        row.updateTime,
        row.docType,
        row.createdAt,
        row.location,
        row.customerPhone,
        row.amount,
      );
    });
    await pool.query(
      `insert into fs_documents
         (collection, id, data, fingerprint, fs_update_time, doc_type, created_at, location, customer_phone, amount)
       values ${values.join(",")}
       on conflict (collection, id) do update set
         data = excluded.data,
         fingerprint = excluded.fingerprint,
         fs_update_time = excluded.fs_update_time,
         doc_type = excluded.doc_type,
         created_at = excluded.created_at,
         location = excluded.location,
         customer_phone = excluded.customer_phone,
         amount = excluded.amount,
         last_copied_at = now(),
         missing_since = null`,
      params,
    );
  }
}

async function markMissing(pool, collection, seenIds) {
  const result = await pool.query(
    `update fs_documents set missing_since = now()
       where collection = $1 and missing_since is null and not (id = any($2::text[]))
       returning id`,
    [collection, seenIds],
  );
  return result.rows.map((row) => row.id);
}

// Worked out from the data as PostgreSQL returns it, so the check proves the
// stored copy matches Firestore rather than echoing what was sent.
async function storedFingerprints(pool, collection) {
  const result = await pool.query(
    "select id, data from fs_documents where collection = $1",
    [collection],
  );
  return new Map(result.rows.map((row) => [row.id, fingerprintOf(row.data)]));
}

// Reads every top-level Firestore collection and copies it. Returns the summary
// that is also saved in sync_runs.
async function runMirror({ db, pool, logger }) {
  const startedAt = new Date().toISOString();
  const collections = (await db.listCollections()).map((ref) => ref.id).sort();
  await ensureSchema(pool, collections);
  const run = await pool.query("insert into sync_runs (started_at) values ($1) returning id", [startedAt]);
  const runId = run.rows[0].id;

  const summary = { collections: {}, problems: [] };
  try {
    for (const collection of collections) {
      const snapshot = await db.collection(collection).get();
      const rows = snapshot.docs.map((doc) => toRow(collection, doc.id, doc.data(), doc.updateTime));
      await upsertRows(pool, rows);
      const missing = await markMissing(pool, collection, rows.map((row) => row.id));
      const check = compareCollection(rows, await storedFingerprints(pool, collection));
      summary.collections[collection] = {
        firestore: check.firestoreCount,
        copied: check.storedCount,
        mismatched: check.mismatched.length,
        newlyMissing: missing.length,
      };
      if (check.mismatched.length || check.storedCount !== check.firestoreCount) {
        summary.problems.push({ collection, mismatched: check.mismatched.slice(0, 20) });
      }
      if (missing.length) {
        summary.removedInFirestore = summary.removedInFirestore || [];
        summary.removedInFirestore.push({ collection, ids: missing.slice(0, 50), count: missing.length });
      }
    }
  } catch (error) {
    summary.problems.push({ error: String(error.message || error) });
    await pool.query("update sync_runs set finished_at = now(), ok = false, summary = $2 where id = $1", [runId, summary]);
    throw error;
  }

  const ok = summary.problems.length === 0;
  await pool.query("update sync_runs set finished_at = now(), ok = $2, summary = $3 where id = $1", [runId, ok, summary]);
  if (!ok) logger?.error("PostgreSQL copy found differences", summary);
  else logger?.info("PostgreSQL copy matched", summary.collections);
  return { runId, ok, ...summary };
}

module.exports = { runMirror, viewName };
