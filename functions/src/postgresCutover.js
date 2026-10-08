// Flag-off path for running the registers without Firestore in the middle.
//
// Nothing in this file runs in the shop today. Callers reach it only when
// `system/dataPaths.live` is exactly "postgres". That field is not set, so
// listeners, ticket numbers, and card-refund locks stay on Firestore and
// every current save, validation, and screen behaves as it does now.
//
// What is already queued on the register (list saves, stock movements,
// appState, customer and balance changes) is unchanged. Firestore's offline
// cache still uniquely covers two things, and the client module closes them
// only while this flag is on: reading customers and lists with no network,
// and a ticket-number claim that the Firestore SDK used to queue by itself.
// Sales keep their entry ids, stock keeps movement ids, and record saves
// still skip an unchanged fingerprint, so a replay cannot apply twice.
//
// Intentionally NOT done. These stay until a real cutover, and turning this
// flag on is not part of this change:
// 1. Firebase Auth. Sign-in is still Firebase Authentication, and these
//    callables still require a signed-in user. Replacing Auth is separate.
// 2. Firestore security rules. firestore.rules still governs every direct
//    client read and write. Do not remove those rules while any register
//    still talks to Firestore.
// 3. The copy trigger (copyFirestoreWrite) and the nightly comparisons
//    (checkRecordsPostgres and the stock comparison) stay until the cutover.
//    They are what proves PostgreSQL still matches Firestore.

const { planRefund, money } = require("./refunds");

const TICKET_MIN = 100001;
const TICKET_MAX = 999999;
const TICKET_LOCK = "repair-ticket-counter";
const PAGE_MAX = 500;
const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

const SCHEMA = `
create table if not exists repair_ticket_counter (
  id integer primary key,
  next_number bigint not null
);
create table if not exists repair_ticket_locks (
  ticket_number text primary key,
  report_id text not null default '',
  claimed_by text,
  claimed_at timestamptz not null default now()
);
create table if not exists repair_ticket_allocations (
  request_id text primary key,
  ticket_number text not null
);
create table if not exists card_refund_ledgers (
  ref_num text primary key,
  charged numeric(14, 2) not null,
  refunded_before numeric(14, 2) not null default 0,
  entries jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists records_collection_updated_idx on records (collection, updated_at, id);
`;

function liveEnabled(paths) {
  return paths?.live === "postgres";
}

function schemaName(schema = "public") {
  const name = String(schema || "public");
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Schema is not valid.");
  return name;
}

async function inTransaction(pool, schema, work) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local search_path to ${schemaName(schema)}, public`);
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

async function ensureCutoverSchema(pool, schema = "public") {
  await inTransaction(pool, schema, (client) => client.query(SCHEMA));
}

function timeText(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toChange(row) {
  const updatedAt = timeText(row.updated_at);
  return {
    id: row.id,
    version: Number(row.version) || 0,
    updatedAt,
    deleted: Boolean(row.deleted_at),
    data: row.deleted_at ? null : row.data,
  };
}

// `version` is per record, so a collection cursor is the row's updated time
// plus its id. Two saves of different records can commit with versions that
// do not increase across the collection; the timestamp is what moves forward.
function cursorAfter(changes, previous) {
  let best = previous || { updatedAt: "1970-01-01T00:00:00.000Z", id: "", version: 0 };
  for (const change of changes) {
    const after = change.updatedAt > best.updatedAt
      || (change.updatedAt === best.updatedAt && change.id > best.id);
    if (after) best = { updatedAt: change.updatedAt, id: change.id, version: change.version };
  }
  return best;
}

function normalizeSpecs(raw) {
  const list = Array.isArray(raw?.collections) ? raw.collections : [];
  if (list.length > 20) throw new Error("Ask for at most 20 collections at a time.");
  return list.map((entry) => {
    const name = String(entry?.name || "");
    if (!COLLECTION_NAME.test(name)) throw new Error("A collection name is not valid.");
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(entry.limit) || 200));
    const recent = Math.min(200, Math.max(0, Number(entry.recent) || 0));
    return {
      name,
      updatedAt: entry.updatedAt ? String(entry.updatedAt) : "",
      id: entry.id ? String(entry.id) : "",
      limit,
      recent,
    };
  });
}

// Records changed since a cursor, one collection at a time. A `recent` ask
// with no cursor returns the newest window (notification history) instead of
// the whole collection. Later asks are deltas, including soft deletes.
async function changesSince(pool, raw, { schema = "public" } = {}) {
  const specs = normalizeSpecs(raw);
  if (!specs.length) return { collections: {} };
  await ensureCutoverSchema(pool, schema);
  return inTransaction(pool, schema, async (client) => {
    const collections = {};
    for (const spec of specs) {
      const useRecent = spec.recent > 0 && !spec.updatedAt;
      const result = useRecent
        ? await client.query(
          `/* recent-window */ select id, data, version, deleted_at, updated_at from records
           where collection = $1 and deleted_at is null
           order by doc_created_at desc nulls last, id desc
           limit $2`,
          [spec.name, spec.recent],
        )
        : await client.query(
          `/* delta-since */ select id, data, version, deleted_at, updated_at from records
           where collection = $1
             and (updated_at > $2::timestamptz or (updated_at = $2::timestamptz and id > $3))
           order by updated_at asc, id asc
           limit $4`,
          [spec.name, spec.updatedAt || "1970-01-01T00:00:00.000Z", spec.id || "", spec.limit + 1],
        );
      const page = useRecent ? result.rows : result.rows.slice(0, spec.limit);
      const changes = page.map(toChange);
      const previous = spec.updatedAt
        ? { updatedAt: spec.updatedAt, id: spec.id || "", version: 0 }
        : { updatedAt: "1970-01-01T00:00:00.000Z", id: "", version: 0 };
      collections[spec.name] = {
        changes,
        caughtUp: useRecent || result.rows.length <= spec.limit,
        cursor: cursorAfter(changes, previous),
      };
    }
    return { collections };
  });
}

function ticketStart(startAt) {
  const start = Number(startAt);
  if (!Number.isFinite(start) || start < TICKET_MIN) return TICKET_MIN;
  return Math.floor(start);
}

// Next free repair-ticket number. The counter row and every existing claim
// sit behind one advisory lock, so two registers in the same moment cannot
// be handed the same number. The same requestId returns the number already
// issued for it and does not take another.
async function allocateRepairTicket(pool, input = {}, { schema = "public" } = {}) {
  const reportId = String(input.reportId || "");
  const claimedBy = input.claimedBy ? String(input.claimedBy) : "";
  const requestId = String(input.requestId || "");
  const start = ticketStart(input.startAt);
  await ensureCutoverSchema(pool, schema);
  return inTransaction(pool, schema, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [TICKET_LOCK]);
    if (requestId) {
      const prior = await client.query(
        "select ticket_number from repair_ticket_allocations where request_id = $1",
        [requestId],
      );
      if (prior.rows.length) return { number: prior.rows[0].ticket_number, repeated: true };
    }
    const counter = await client.query("select next_number from repair_ticket_counter where id = 1");
    const maxTaken = await client.query("select max(ticket_number::bigint) as max from repair_ticket_locks");
    let candidate = Math.max(start, Number(counter.rows[0]?.next_number) || 0, (Number(maxTaken.rows[0]?.max) || 0) + 1);
    if (!Number.isFinite(candidate) || candidate < TICKET_MIN) candidate = TICKET_MIN;
    for (let tries = 0; tries < 40; tries += 1) {
      if (candidate > TICKET_MAX) return { number: null };
      const inserted = await client.query(
        `insert into repair_ticket_locks (ticket_number, report_id, claimed_by)
         values ($1, $2, $3)
         on conflict (ticket_number) do nothing
         returning ticket_number`,
        [String(candidate), reportId, claimedBy || null],
      );
      if (inserted.rows.length) {
        const number = String(inserted.rows[0].ticket_number);
        await client.query(
          `insert into repair_ticket_counter (id, next_number) values (1, $1)
           on conflict (id) do update set next_number = greatest(repair_ticket_counter.next_number, excluded.next_number)`,
          [candidate + 1],
        );
        if (requestId) {
          await client.query(
            "insert into repair_ticket_allocations (request_id, ticket_number) values ($1, $2)",
            [requestId, number],
          );
        }
        return { number, repeated: false };
      }
      candidate += 1;
    }
    return { number: null };
  });
}

function ownsTicket(row, reportId, claimedBy) {
  if (reportId && row.report_id === reportId) return true;
  return Boolean(claimedBy && row.claimed_by === claimedBy && !row.report_id);
}

// Claim a number for one repair. The same repair claiming again is a repeat,
// not a clash. A different repair finds the number taken.
async function claimRepairTicketPg(pool, input = {}, { schema = "public" } = {}) {
  const number = String(input.ticketNumber || "").trim();
  const reportId = String(input.reportId || "");
  const claimedBy = input.claimedBy ? String(input.claimedBy) : "";
  if (!/^\d{6}$/.test(number)) return { status: "unconfirmed" };
  await ensureCutoverSchema(pool, schema);
  return inTransaction(pool, schema, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [TICKET_LOCK]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`repair-ticket:${number}`]);
    const existing = await client.query(
      "select report_id, claimed_by from repair_ticket_locks where ticket_number = $1",
      [number],
    );
    if (existing.rows.length) {
      return { status: ownsTicket(existing.rows[0], reportId, claimedBy) ? "claimed" : "taken" };
    }
    await client.query(
      `insert into repair_ticket_locks (ticket_number, report_id, claimed_by)
       values ($1, $2, $3)`,
      [number, reportId, claimedBy || null],
    );
    await client.query(
      `insert into repair_ticket_counter (id, next_number) values (1, $1)
       on conflict (id) do update set next_number = greatest(repair_ticket_counter.next_number, excluded.next_number)`,
      [Number(number) + 1],
    );
    return { status: "claimed" };
  });
}

function ledgerOf(row, charged) {
  return {
    refNum: row.ref_num,
    charged: money(charged),
    refundedBefore: money(row.refunded_before),
    entries: row.entries || {},
  };
}

// The card-refund lock, in one Postgres transaction. Same rules as the
// Firestore ledger: a repeated refund id is not charged twice, and two
// concurrent refunds cannot together exceed what the card took.
async function reserveCardRefundPg(pool, input, { schema = "public" } = {}) {
  const refNum = String(input.refNum || "");
  const refundId = String(input.refundId || "");
  if (!refNum || !refundId) {
    return { refuse: true, status: 400, message: "A card reference and a refund id are required." };
  }
  const charged = money(input.charged);
  const amount = money(input.amount);
  await ensureCutoverSchema(pool, schema);
  return inTransaction(pool, schema, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`card-refund:${refNum}`]);
    const existing = await client.query(
      "select ref_num, charged, refunded_before, entries from card_refund_ledgers where ref_num = $1",
      [refNum],
    );
    const ledger = existing.rows.length
      ? ledgerOf(existing.rows[0], charged)
      : {
        refNum,
        charged,
        refundedBefore: money(input.refundedBefore),
        entries: input.seedEntries && typeof input.seedEntries === "object" ? input.seedEntries : {},
      };
    const plan = planRefund(ledger, {
      refundId,
      amount,
      kind: input.kind === "deposit" ? "deposit" : "sale",
      report: input.report || null,
    });
    if (plan.action === "refuse") return { refuse: true, status: plan.status, message: plan.message };
    if (plan.action === "repeat") return { repeat: true, entry: plan.entry };
    const entries = { ...(ledger.entries || {}) };
    entries[refundId] = {
      amount,
      kind: input.kind === "deposit" ? "deposit" : "sale",
      reportId: String(input.reportId || ""),
      status: "pending",
      by: String(input.by || ""),
      at: new Date().toISOString(),
    };
    await client.query(
      `insert into card_refund_ledgers (ref_num, charged, refunded_before, entries)
       values ($1, $2, $3, $4::jsonb)
       on conflict (ref_num) do update set
         charged = excluded.charged,
         entries = excluded.entries,
         updated_at = now()`,
      [refNum, charged, ledger.refundedBefore, JSON.stringify(entries)],
    );
    return { ledgerRef: { postgres: true, refNum } };
  });
}

async function settleCardRefundPg(pool, refNum, refundId, fields, { schema = "public" } = {}) {
  await ensureCutoverSchema(pool, schema);
  return inTransaction(pool, schema, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`card-refund:${refNum}`]);
    const result = await client.query("select entries from card_refund_ledgers where ref_num = $1", [refNum]);
    if (!result.rows.length) return { missing: true };
    const entries = { ...(result.rows[0].entries || {}) };
    if (!entries[refundId]) return { missing: true };
    entries[refundId] = { ...entries[refundId], ...fields };
    await client.query(
      "update card_refund_ledgers set entries = $2::jsonb, updated_at = now() where ref_num = $1",
      [refNum, JSON.stringify(entries)],
    );
    return { ok: true };
  });
}

function prefixUpper(prefix) {
  return `${prefix}\uf8ff`;
}

// Customer lookup against the records table, for when the register is not
// reading Firestore. Exact phone, phone prefix, or name prefix.
async function findCustomers(pool, input = {}, { schema = "public" } = {}) {
  const limit = Math.min(50, Math.max(1, Number(input.limit) || 8));
  const digits = String(input.digits || "").replace(/\D/g, "");
  const prefix = String(input.prefix || "").replace(/\D/g, "");
  const namePrefix = String(input.namePrefix || "");
  const afterId = String(input.afterId || "");
  await ensureCutoverSchema(pool, schema);
  return inTransaction(pool, schema, async (client) => {
    let afterValue = "";
    if (afterId) {
      const cursor = await client.query(
        "/* customer-cursor */ select data->>'name' as name, data->>'phoneDigits' as phone from records where collection = 'customers' and id = $1",
        [afterId],
      );
      afterValue = prefix ? (cursor.rows[0]?.phone || "") : (cursor.rows[0]?.name || "");
    }
    let result;
    if (digits) {
      result = await client.query(
        `/* customer-exact */ select id, data from records
         where collection = 'customers' and deleted_at is null
           and (data->>'phoneDigits' = $1 or data->>'mobileDigits' = $1)
         limit 1`,
        [digits],
      );
    } else if (prefix) {
      result = await client.query(
        `/* customer-prefix */ select id, data from records
         where collection = 'customers' and deleted_at is null
           and data->>'phoneDigits' >= $1 and data->>'phoneDigits' < $2
           and ($3 = '' or data->>'phoneDigits' > $3 or (data->>'phoneDigits' = $3 and id > $4))
         order by data->>'phoneDigits', id
         limit $5`,
        [prefix, prefixUpper(prefix), afterValue, afterId, limit],
      );
    } else if (namePrefix || afterId) {
      const lower = namePrefix || "";
      const upper = namePrefix ? prefixUpper(namePrefix) : "\uf8ff";
      result = await client.query(
        `/* customer-name */ select id, data from records
         where collection = 'customers' and deleted_at is null
           and data->>'name' >= $1 and data->>'name' < $2
           and ($3 = '' or data->>'name' > $3 or (data->>'name' = $3 and id > $4))
         order by data->>'name', id
         limit $5`,
        [lower, upper, afterValue, afterId, limit],
      );
    } else {
      result = await client.query(
        `/* customer-name */ select id, data from records
         where collection = 'customers' and deleted_at is null
         order by data->>'name', id
         limit $1`,
        [limit],
      );
    }
    return {
      customers: result.rows.map((row) => ({ id: row.id, ...(row.data || {}) })),
    };
  });
}

function authOf(request) {
  const token = request.auth?.token || {};
  return { uid: request.auth?.uid || "", admin: token.role === "admin" || token.admin === true };
}

async function handlePollRecords({ request, pool, HttpsError, live }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!live) return { disabled: true, collections: {} };
  try {
    return await changesSince(pool, request.data || {});
  } catch (error) {
    if (/not valid|at most/.test(error.message || "")) throw new HttpsError("invalid-argument", error.message);
    throw new HttpsError("unavailable", "The database could not be reached.");
  }
}

async function handleAllocateRepairTicket({ request, pool, HttpsError, live }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!live) return { number: null };
  const data = request.data || {};
  return allocateRepairTicket(pool, {
    startAt: data.startAt,
    reportId: data.reportId,
    claimedBy: authOf(request).uid,
    requestId: data.requestId,
  });
}

async function handleClaimRepairTicket({ request, pool, HttpsError, live }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!live) return { status: "unconfirmed" };
  const data = request.data || {};
  return claimRepairTicketPg(pool, {
    ticketNumber: data.ticketNumber,
    reportId: data.reportId,
    claimedBy: authOf(request).uid,
  });
}

async function handleFindCustomers({ request, pool, HttpsError, live }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!live) return { disabled: true, customers: [] };
  try {
    return await findCustomers(pool, request.data || {});
  } catch {
    throw new HttpsError("unavailable", "The database could not be reached.");
  }
}

module.exports = {
  allocateRepairTicket,
  changesSince,
  claimRepairTicketPg,
  ensureCutoverSchema,
  findCustomers,
  handleAllocateRepairTicket,
  handleClaimRepairTicket,
  handleFindCustomers,
  handlePollRecords,
  liveEnabled,
  reserveCardRefundPg,
  settleCardRefundPg,
};
