// The official copy of every record, in PostgreSQL. Each save is one
// transaction: the records it touches are locked, checked against the same
// permissions as firestore.rules, written with a new version, and every
// version is kept in record_history. A delete only marks the record. The
// Firestore copy is written while the locks are held, so two saves of the
// same record reach Firestore in the order they were made here.

const { encodeValue, fingerprintOf, searchColumns } = require("./pgMirror");
const { nextData, normalizeOps, permitted, withoutStock } = require("./records");

const SCHEMA = `
create table if not exists records (
  collection text not null,
  id text not null,
  data jsonb not null,
  fingerprint text not null,
  version bigint not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  origin text not null,
  fs_update_time timestamptz,
  doc_type text,
  doc_created_at timestamptz,
  location text,
  customer_phone text,
  amount numeric(14, 2),
  primary key (collection, id)
);
create index if not exists records_type_idx on records (collection, doc_type, doc_created_at);
create index if not exists records_phone_idx on records (customer_phone);
create index if not exists records_location_idx on records (collection, location, doc_created_at);
create table if not exists record_history (
  history_id bigserial primary key,
  collection text not null,
  id text not null,
  version bigint not null,
  op text not null,
  data jsonb,
  origin text not null,
  actor text,
  at timestamptz not null default now()
);
create index if not exists record_history_doc_idx on record_history (collection, id, version);
create table if not exists customer_balance_entries (
  entry_id text primary key,
  customer_id text not null,
  amount numeric(12, 2) not null,
  balance_after numeric(12, 2) not null,
  kind text,
  reason text,
  by_name text,
  actor text,
  at timestamptz not null default now()
);
create index if not exists customer_balance_entries_customer_idx on customer_balance_entries (customer_id, at);
`;

class SaveRefused extends Error {
  constructor(message, code = "permission-denied") {
    super(message);
    this.code = code;
  }
}

async function inTransaction(pool, schema, work) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local search_path to ${schema}, public`);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureRecordSchema(pool, schema = "public") {
  await inTransaction(pool, schema, (client) => client.query(SCHEMA));
}

function keyOf(collection, id) {
  return `${collection}/${id}`;
}

// Locks by key whether or not the record exists yet, always in the same
// order, so two saves can never wait on each other in a circle.
async function lockKeys(client, keys) {
  for (const key of [...new Set(keys)].sort()) {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

async function readRecord(client, collection, id) {
  const result = await client.query(
    "select data, fingerprint, version, deleted_at, fs_update_time from records where collection = $1 and id = $2",
    [collection, id],
  );
  return result.rows[0] || null;
}

async function writeRecord(client, { collection, id, data, version, origin, actor, deleted, fsUpdateTime }) {
  await upsertRecordRow(client, collection, id, { data, version, deleted, fsUpdateTime }, origin, actor);
  await client.query(
    `insert into record_history (collection, id, version, op, data, origin, actor)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [collection, id, version, deleted ? "delete" : "write", deleted ? null : JSON.stringify(data), origin, actor || null],
  );
}

// Saves from a register. `mirror(changes)` writes the Firestore copy and
// returns the write time of each change, in order.
async function saveRecords(pool, rawOps, { auth, origin = "register", mirror, schema = "public" }) {
  const ops = normalizeOps(rawOps);
  return inTransaction(pool, schema, async (client) => {
    await lockKeys(client, ops.map((op) => keyOf(op.collection, op.id)));
    const current = new Map();
    const changes = [];
    for (const op of ops) {
      const key = keyOf(op.collection, op.id);
      if (!current.has(key)) current.set(key, await readRecord(client, op.collection, op.id));
      const row = current.get(key);
      const existing = row && !row.deleted_at ? row.data : null;
      if (!permitted(auth, existing, op)) {
        throw new SaveRefused(`You are not allowed to ${op.type === "delete" ? "remove" : "save"} that ${op.collection} record.`);
      }
      if (op.type === "delete" && !existing) continue;
      const data = op.type === "delete" ? null : encodeValue(nextData(existing, op));
      if (data && existing && fingerprintOf(data) === row.fingerprint) continue;
      const version = (Number(row?.version) || 0) + 1;
      const next = {
        data: data || row.data,
        fingerprint: data ? fingerprintOf(data) : row.fingerprint,
        version,
        deleted_at: data ? null : new Date(),
        fs_update_time: row?.fs_update_time || null,
      };
      current.set(key, next);
      changes.push({ op, key, version, data: next.data, deleted: !data });
    }
    if (!changes.length) return { saved: 0 };

    const writeTimes = mirror ? await mirror(changes.map(({ op, deleted, data }) => ({
      collection: op.collection,
      id: op.id,
      type: deleted ? "delete" : op.type,
      data: deleted ? null : (op.collection === "products" || op.type === "merge" ? withoutStock(op.collection, op.data) : data),
    }))) : [];

    // Only the last change to each record is stored; the history keeps every one.
    const lastByKey = new Map();
    changes.forEach((change, index) => lastByKey.set(change.key, { ...change, fsUpdateTime: writeTimes[index] || null }));
    for (const change of changes) {
      await client.query(
        `insert into record_history (collection, id, version, op, data, origin, actor)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [change.op.collection, change.op.id, change.version, change.deleted ? "delete" : "write",
          change.deleted ? null : JSON.stringify(change.data), origin, auth?.uid || null],
      );
    }
    for (const change of lastByKey.values()) {
      await upsertRecordRow(client, change.op.collection, change.op.id, change, origin, auth?.uid);
    }
    return { saved: changes.length };
  });
}

async function upsertRecordRow(client, collection, id, change, origin, actor) {
  const columns = searchColumns(change.data);
  await client.query(
    `insert into records (collection, id, data, fingerprint, version, deleted_at, updated_by, origin, fs_update_time,
                          doc_type, doc_created_at, location, customer_phone, amount)
     values ($1, $2, $3::jsonb, $4, $5, case when $6 then now() else null end, $7, $8, $9::timestamptz, $10, $11::timestamptz, $12, $13, $14)
     on conflict (collection, id) do update set
       data = excluded.data, fingerprint = excluded.fingerprint, version = excluded.version,
       deleted_at = excluded.deleted_at, updated_at = now(), updated_by = excluded.updated_by,
       origin = excluded.origin, fs_update_time = coalesce(excluded.fs_update_time, records.fs_update_time),
       doc_type = excluded.doc_type, doc_created_at = excluded.doc_created_at, location = excluded.location,
       customer_phone = excluded.customer_phone, amount = excluded.amount`,
    [collection, id, JSON.stringify(change.data), fingerprintOf(change.data), change.version, Boolean(change.deleted),
      actor || null, origin, change.fsUpdateTime || null, columns.docType, columns.createdAt, columns.location,
      columns.customerPhone, columns.amount],
  );
}

// A Firestore document changed. Anything this store wrote itself already
// matches and is skipped; anything else (a webhook, a scheduled job, a
// register still on the old path) becomes a new version here. An event older
// than what is stored is ignored, since events can arrive out of order.
async function recordFirestoreChange(pool, { collection, id, data, updateTime }, { schema = "public" } = {}) {
  return inTransaction(pool, schema, async (client) => {
    await lockKeys(client, [keyOf(collection, id)]);
    const row = await readRecord(client, collection, id);
    if (row?.fs_update_time && updateTime && new Date(row.fs_update_time) > new Date(updateTime)) {
      return { action: "older" };
    }
    if (data === null) {
      if (!row || row.deleted_at) return { action: "same" };
      await writeRecord(client, {
        collection, id, data: row.data, version: Number(row.version) + 1, origin: "firestore", deleted: true, fsUpdateTime: updateTime,
      });
      return { action: "deleted" };
    }
    const encoded = encodeValue(data);
    if (row && !row.deleted_at && fingerprintOf(encoded) === row.fingerprint) {
      if (updateTime) {
        await client.query(
          "update records set fs_update_time = $3 where collection = $1 and id = $2 and (fs_update_time is null or fs_update_time < $3)",
          [collection, id, updateTime],
        );
      }
      return { action: "same" };
    }
    await writeRecord(client, {
      collection, id, data: encoded, version: (Number(row?.version) || 0) + 1, origin: "firestore", fsUpdateTime: updateTime,
    });
    return { action: row ? "updated" : "created" };
  });
}

// First fill. A record already here (from the trigger) is left alone.
async function seedCollection(pool, collection, docs, { schema = "public" } = {}) {
  let inserted = 0;
  await inTransaction(pool, schema, async (client) => {
    for (const doc of docs) {
      const data = encodeValue(doc.data);
      const columns = searchColumns(data);
      const result = await client.query(
        `insert into records (collection, id, data, fingerprint, version, origin, fs_update_time,
                              doc_type, doc_created_at, location, customer_phone, amount)
         values ($1, $2, $3::jsonb, $4, 1, 'seed', $5::timestamptz, $6, $7::timestamptz, $8, $9, $10)
         on conflict (collection, id) do nothing returning id`,
        [collection, doc.id, JSON.stringify(data), fingerprintOf(data), doc.updateTime || null,
          columns.docType, columns.createdAt, columns.location, columns.customerPhone, columns.amount],
      );
      if (result.rows.length) {
        inserted += 1;
        await client.query(
          `insert into record_history (collection, id, version, op, data, origin)
           values ($1, $2, 1, 'write', $3::jsonb, 'seed')`,
          [collection, doc.id, JSON.stringify(data)],
        );
      }
    }
  });
  return inserted;
}

// Firestore against the official copy, for one collection. Fingerprints are
// worked out from the data PostgreSQL hands back.
async function compareWithFirestore(pool, collection, docs, { schema = "public" } = {}) {
  const stored = await inTransaction(pool, schema, (client) => client.query(
    "select id, data, deleted_at from records where collection = $1",
    [collection],
  ));
  const live = new Map();
  for (const row of stored.rows) if (!row.deleted_at) live.set(row.id, fingerprintOf(row.data));
  const onlyInFirestore = [];
  const different = [];
  const seen = new Set();
  for (const doc of docs) {
    seen.add(doc.id);
    const fingerprint = fingerprintOf(encodeValue(doc.data));
    if (!live.has(doc.id)) onlyInFirestore.push(doc.id);
    else if (live.get(doc.id) !== fingerprint) different.push(doc.id);
  }
  const onlyInPostgres = [...live.keys()].filter((id) => !seen.has(id));
  return { firestore: docs.length, postgres: live.size, onlyInFirestore, onlyInPostgres, different };
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Money on a customer's account, the same rule as the register used: the
// change is added to the balance in one locked step, and the newest 50
// entries stay on the customer. Every entry is also kept in its own table.
async function adjustBalance(pool, { customerId, amount, reason, by, kind, entryId, at }, { auth, mirror, schema = "public" }) {
  const delta = money(amount);
  if (!customerId || !delta) return null;
  return inTransaction(pool, schema, async (client) => {
    await lockKeys(client, [keyOf("customers", customerId)]);
    const done = await client.query("select balance_after from customer_balance_entries where entry_id = $1", [entryId]);
    const row = await readRecord(client, "customers", customerId);
    if (!row || row.deleted_at) throw new SaveRefused("That customer is no longer in the CRM.", "not-found");
    if (done.rows.length) {
      return { balance: money(row.data.balance), entry: (row.data.balanceEntries || []).find((item) => item.id === entryId) || null, repeated: true };
    }
    if (!permitted(auth, row.data, { collection: "customers", type: "merge" })) throw new SaveRefused("You are not allowed to change that customer.");
    const balance = money(money(row.data.balance) + delta);
    const entry = {
      id: entryId,
      at,
      by: by || "",
      kind: kind || (delta > 0 ? "Credit added" : "Credit used"),
      reason: String(reason || "").trim(),
      amount: delta.toFixed(2),
      balanceAfter: balance.toFixed(2),
    };
    const patch = {
      balance,
      balanceEntries: [entry, ...(row.data.balanceEntries || [])].slice(0, 50),
      balanceUpdatedAt: at,
    };
    const data = encodeValue({ ...row.data, ...patch });
    const version = Number(row.version) + 1;
    const [writeTime] = mirror ? await mirror([{ collection: "customers", id: customerId, type: "merge", data: patch }]) : [];
    await writeRecord(client, {
      collection: "customers", id: customerId, data, version, origin: "register", actor: auth?.uid, fsUpdateTime: writeTime,
    });
    await client.query(
      `insert into customer_balance_entries (entry_id, customer_id, amount, balance_after, kind, reason, by_name, actor, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [entryId, customerId, delta, balance, entry.kind, entry.reason, entry.by, auth?.uid || null, at],
    );
    return { balance, entry };
  });
}

module.exports = {
  SaveRefused,
  adjustBalance,
  compareWithFirestore,
  ensureRecordSchema,
  recordFirestoreChange,
  saveRecords,
  seedCollection,
};
