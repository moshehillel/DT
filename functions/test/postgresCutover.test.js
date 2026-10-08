const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allocateRepairTicket,
  changesSince,
  claimRepairTicketPg,
  findCustomers,
  handlePollRecords,
  liveEnabled,
  reserveCardRefundPg,
  settleCardRefundPg,
} = require("../src/postgresCutover");

function releaseLocks(state, clientId) {
  for (const lock of state.locks.values()) {
    if (lock.holder !== clientId) continue;
    const next = lock.queue.shift();
    lock.holder = next ? next.clientId : null;
    if (next) next.resolve();
  }
}

async function acquire(state, key, clientId) {
  let lock = state.locks.get(key);
  if (!lock) {
    lock = { holder: null, queue: [] };
    state.locks.set(key, lock);
  }
  if (!lock.holder) {
    lock.holder = clientId;
    return;
  }
  await new Promise((resolve) => lock.queue.push({ clientId, resolve }));
  lock.holder = clientId;
}

function compact(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

async function dispatch(state, clientId, sql, params) {
  const text = compact(sql);
  if (text === "begin" || text.startsWith("set local")) return { rows: [] };
  if (text === "commit" || text === "rollback") {
    releaseLocks(state, clientId);
    return { rows: [] };
  }
  if (text.startsWith("create ") || text.startsWith("create table") || text.includes("create table if not exists")) {
    return { rows: [] };
  }
  if (text.includes("pg_advisory_xact_lock")) {
    await acquire(state, params[0], clientId);
    return { rows: [] };
  }
  if (text.includes("insert into repair_ticket_allocations")) {
    state.allocations.set(params[0], params[1]);
    return { rows: [] };
  }
  if (text.includes("insert into repair_ticket_counter")) {
    const next = Number(params[0]);
    state.counter = state.counter == null ? next : Math.max(state.counter, next);
    return { rows: [] };
  }
  if (text.includes("insert into repair_ticket_locks")) {
    const number = String(params[0]);
    if (state.tickets.has(number)) {
      if (text.includes("on conflict")) return { rows: [] };
      throw new Error("duplicate ticket");
    }
    state.tickets.set(number, {
      ticket_number: number,
      report_id: params[1] || "",
      claimed_by: params[2] || "",
    });
    return { rows: [{ ticket_number: number }] };
  }
  if (text.includes("from repair_ticket_allocations")) {
    const number = state.allocations.get(params[0]);
    return { rows: number ? [{ ticket_number: number }] : [] };
  }
  if (text.includes("from repair_ticket_counter")) {
    return { rows: state.counter == null ? [] : [{ next_number: state.counter }] };
  }
  if (text.includes("max(ticket_number::bigint)")) {
    let max = null;
    for (const ticket of state.tickets.values()) {
      const value = Number(ticket.ticket_number);
      if (max == null || value > max) max = value;
    }
    return { rows: [{ max }] };
  }
  if (text.includes("from repair_ticket_locks where ticket_number")) {
    const row = state.tickets.get(String(params[0]));
    return { rows: row ? [{ report_id: row.report_id, claimed_by: row.claimed_by }] : [] };
  }
  if (text.includes("insert into card_refund_ledgers")) {
    const entries = typeof params[3] === "string" ? JSON.parse(params[3]) : params[3];
    const existing = state.ledgers.get(params[0]);
    state.ledgers.set(params[0], {
      ref_num: params[0],
      charged: params[1],
      refunded_before: existing ? existing.refunded_before : params[2],
      entries,
    });
    return { rows: [] };
  }
  if (text.includes("update card_refund_ledgers")) {
    const row = state.ledgers.get(params[0]);
    if (!row) return { rows: [] };
    row.entries = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
    return { rows: [] };
  }
  if (text.includes("from card_refund_ledgers")) {
    const row = state.ledgers.get(params[0]);
    if (!row) return { rows: [] };
    if (text.includes("select entries")) return { rows: [{ entries: row.entries }] };
    return { rows: [{ ...row, entries: row.entries }] };
  }
  if (text.includes("recent-window")) {
    const rows = state.records
      .filter((row) => row.collection === params[0] && !row.deleted_at)
      .sort((a, b) => String(b.doc_created_at).localeCompare(String(a.doc_created_at))
        || String(b.id).localeCompare(String(a.id)))
      .slice(0, params[1]);
    return { rows };
  }
  if (text.includes("delta-since")) {
    const updatedAt = params[1];
    const id = params[2];
    const limit = params[3];
    const rows = state.records
      .filter((row) => row.collection === params[0])
      .filter((row) => row.updated_at > updatedAt || (row.updated_at === updatedAt && row.id > id))
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)))
      .slice(0, limit);
    return { rows };
  }
  if (text.includes("customer-cursor")) {
    const row = state.records.find((item) => item.collection === "customers" && item.id === params[0]);
    if (!row) return { rows: [] };
    return { rows: [{ name: row.data?.name || "", phone: row.data?.phoneDigits || "" }] };
  }
  if (text.includes("customer-exact")) {
    const row = state.records.find((item) => item.collection === "customers" && !item.deleted_at
      && (item.data?.phoneDigits === params[0] || item.data?.mobileDigits === params[0]));
    return { rows: row ? [{ id: row.id, data: row.data }] : [] };
  }
  if (text.includes("customer-prefix")) {
    const [prefix, upper, afterValue, afterId, limit] = params;
    const rows = state.records
      .filter((item) => item.collection === "customers" && !item.deleted_at)
      .filter((item) => {
        const phone = item.data?.phoneDigits || "";
        return phone >= prefix && phone < upper;
      })
      .filter((item) => {
        if (!afterValue) return true;
        const phone = item.data?.phoneDigits || "";
        return phone > afterValue || (phone === afterValue && item.id > afterId);
      })
      .sort((a, b) => (a.data.phoneDigits < b.data.phoneDigits ? -1 : a.data.phoneDigits > b.data.phoneDigits ? 1 : (a.id < b.id ? -1 : 1)))
      .slice(0, limit);
    return { rows: rows.map((row) => ({ id: row.id, data: row.data })) };
  }
  if (text.includes("customer-name")) {
    let rows = state.records.filter((item) => item.collection === "customers" && !item.deleted_at);
    if (params.length > 1) {
      const [lower, upper, afterValue, afterId, limit] = params;
      rows = rows
        .filter((item) => {
          const name = item.data?.name || "";
          return name >= lower && name < upper;
        })
        .filter((item) => {
          if (!afterValue) return true;
          const name = item.data?.name || "";
          return name > afterValue || (name === afterValue && item.id > afterId);
        })
        .sort((a, b) => (a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : (a.id < b.id ? -1 : 1)))
        .slice(0, limit);
    } else {
      rows = rows
        .sort((a, b) => String(a.data?.name).localeCompare(String(b.data?.name)) || (a.id < b.id ? -1 : 1))
        .slice(0, params[0]);
    }
    return { rows: rows.map((row) => ({ id: row.id, data: row.data })) };
  }
  throw new Error(`Unexpected SQL: ${text}`);
}

function createPool(records = []) {
  const state = {
    counter: null,
    tickets: new Map(),
    allocations: new Map(),
    ledgers: new Map(),
    records: records.map((row) => ({ ...row })),
    locks: new Map(),
  };
  let nextId = 1;
  return {
    state,
    async connect() {
      const clientId = nextId++;
      return {
        async query(sql, params = []) {
          await Promise.resolve();
          return dispatch(state, clientId, sql, params);
        },
        release() {},
      };
    },
  };
}

function record(partial) {
  return {
    collection: "reports",
    id: "a",
    data: { name: "A" },
    version: 1,
    deleted_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    doc_created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("the live flag stays off unless dataPaths.live is postgres", () => {
  assert.equal(liveEnabled(undefined), false);
  assert.equal(liveEnabled({}), false);
  assert.equal(liveEnabled({ stock: "postgres" }), false);
  assert.equal(liveEnabled({ live: "firestore" }), false);
  assert.equal(liveEnabled({ live: "postgres" }), true);
});

test("a poll while the flag is off does not read the database", async () => {
  const result = await handlePollRecords({
    request: { auth: { uid: "u1" } },
    pool: null,
    HttpsError: class extends Error {},
    live: false,
  });
  assert.deepEqual(result, { disabled: true, collections: {} });
});

test("two parallel ticket allocations never share a number", async () => {
  for (let round = 0; round < 15; round += 1) {
    const pool = createPool();
    const results = await Promise.all([
      allocateRepairTicket(pool, { startAt: 100001, reportId: "left" }),
      allocateRepairTicket(pool, { startAt: 100001, reportId: "right" }),
    ]);
    const numbers = results.map((result) => result.number);
    assert.equal(numbers.filter(Boolean).length, 2, `round ${round}`);
    assert.equal(new Set(numbers).size, 2, `round ${round} shared ${numbers.join(",")}`);
  }
});

test("five allocations at once are five different next numbers", async () => {
  const pool = createPool();
  const results = await Promise.all(
    ["a", "b", "c", "d", "e"].map((id) => allocateRepairTicket(pool, { startAt: 100001, reportId: id })),
  );
  assert.deepEqual(results.map((result) => result.number).sort(), ["100001", "100002", "100003", "100004", "100005"]);
});

test("allocation will not hand out a number that was already claimed", async () => {
  const pool = createPool();
  const claimed = await claimRepairTicketPg(pool, { ticketNumber: "100001", reportId: "already" });
  assert.equal(claimed.status, "claimed");
  const next = await allocateRepairTicket(pool, { startAt: 100001, reportId: "other" });
  assert.equal(next.number, "100002");
  assert.equal(pool.state.tickets.has("100001"), true);
});

test("the same allocation request returns the number it already took", async () => {
  const pool = createPool();
  const first = await allocateRepairTicket(pool, { startAt: 100001, reportId: "r1", requestId: "req-1" });
  const second = await allocateRepairTicket(pool, { startAt: 100001, reportId: "r1", requestId: "req-1" });
  assert.equal(first.number, "100001");
  assert.equal(second.number, "100001");
  assert.equal(second.repeated, true);
  assert.equal(pool.state.tickets.size, 1);
});

test("two claims of one ticket number leave it with exactly one repair", async () => {
  for (let round = 0; round < 15; round += 1) {
    const pool = createPool();
    const results = await Promise.all([
      claimRepairTicketPg(pool, { ticketNumber: "100500", reportId: "a" }),
      claimRepairTicketPg(pool, { ticketNumber: "100500", reportId: "b" }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["claimed", "taken"]);
    assert.equal(pool.state.tickets.size, 1);
  }
});

test("the repair that already owns a number can claim it again", async () => {
  const pool = createPool();
  assert.equal((await claimRepairTicketPg(pool, { ticketNumber: "100500", reportId: "a" })).status, "claimed");
  assert.equal((await claimRepairTicketPg(pool, { ticketNumber: "100500", reportId: "a" })).status, "claimed");
  assert.equal((await claimRepairTicketPg(pool, { ticketNumber: "100500", reportId: "b" })).status, "taken");
});

test("two refunds at once cannot exceed what the card was charged", async () => {
  for (let round = 0; round < 15; round += 1) {
    const pool = createPool();
    const input = { refNum: "REF1", charged: 100, refundedBefore: 0, report: { id: "sale" }, kind: "sale", reportId: "sale" };
    const results = await Promise.all([
      reserveCardRefundPg(pool, { ...input, refundId: "one", amount: 60 }),
      reserveCardRefundPg(pool, { ...input, refundId: "two", amount: 60 }),
    ]);
    const reserved = results.filter((result) => result.ledgerRef);
    const refused = results.filter((result) => result.refuse);
    assert.equal(reserved.length, 1, `round ${round}`);
    assert.equal(refused.length, 1, `round ${round}`);
    assert.equal(refused[0].status, 409);
  }
});

test("a refund id is reserved once, a decline frees it, and an approval repeats", async () => {
  const pool = createPool();
  const input = { refNum: "REF9", charged: 100, refundedBefore: 0, report: { id: "sale" }, kind: "sale", reportId: "sale" };
  const first = await reserveCardRefundPg(pool, { ...input, refundId: "same", amount: 80 });
  assert.ok(first.ledgerRef?.postgres);
  const pending = await reserveCardRefundPg(pool, { ...input, refundId: "same", amount: 80 });
  assert.equal(pending.refuse, true);
  assert.equal(pending.status, 409);
  await settleCardRefundPg(pool, "REF9", "same", { status: "declined" });
  const again = await reserveCardRefundPg(pool, { ...input, refundId: "other", amount: 80 });
  assert.ok(again.ledgerRef);
  await settleCardRefundPg(pool, "REF9", "other", { status: "approved", solaRef: "S1" });
  const repeat = await reserveCardRefundPg(pool, { ...input, refundId: "other", amount: 80 });
  assert.equal(repeat.repeat, true);
  assert.equal(repeat.entry.solaRef, "S1");
});

test("changes since a cursor return later rows, deletes, and the next page", async () => {
  const pool = createPool([
    record({ id: "a", version: 1, updated_at: "2026-01-01T00:00:00.000Z", data: { n: 1 } }),
    record({ id: "b", version: 4, updated_at: "2026-01-01T00:00:00.000Z", data: { n: 2 } }),
    record({ id: "c", version: 2, updated_at: "2026-01-02T00:00:00.000Z", data: { n: 3 } }),
    record({
      id: "d",
      version: 3,
      updated_at: "2026-01-03T00:00:00.000Z",
      deleted_at: "2026-01-03T00:00:00.000Z",
      data: { n: 4 },
    }),
  ]);
  const first = await changesSince(pool, {
    collections: [{ name: "reports", limit: 2 }],
  });
  assert.deepEqual(first.collections.reports.changes.map((change) => change.id), ["a", "b"]);
  assert.equal(first.collections.reports.caughtUp, false);
  assert.equal(first.collections.reports.changes[1].version, 4);
  const second = await changesSince(pool, {
    collections: [{ name: "reports", ...first.collections.reports.cursor, limit: 2 }],
  });
  assert.deepEqual(second.collections.reports.changes.map((change) => [change.id, change.deleted]), [
    ["c", false],
    ["d", true],
  ]);
  assert.equal(second.collections.reports.changes[1].data, null);
  assert.equal(second.collections.reports.caughtUp, true);
  const third = await changesSince(pool, {
    collections: [{ name: "reports", ...second.collections.reports.cursor, limit: 2 }],
  });
  assert.deepEqual(third.collections.reports.changes, []);
  assert.equal(third.collections.reports.cursor.id, second.collections.reports.cursor.id);
});

test("a recent window is the newest rows, not the whole collection", async () => {
  const pool = createPool([
    record({ id: "old", doc_created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }),
    record({ id: "mid", doc_created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" }),
    record({ id: "new", doc_created_at: "2026-03-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z" }),
    record({
      id: "gone",
      doc_created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      deleted_at: "2026-04-01T00:00:00.000Z",
    }),
  ]);
  const page = await changesSince(pool, {
    collections: [{ name: "reports", recent: 2 }],
  });
  assert.deepEqual(page.collections.reports.changes.map((change) => change.id), ["new", "mid"]);
  assert.equal(page.collections.reports.caughtUp, true);
  assert.equal(page.collections.reports.cursor.id, "new");
});

test("customer lookup finds an exact phone and a prefix, and skips a deleted row", async () => {
  const pool = createPool([
    record({
      collection: "customers",
      id: "c1",
      data: { name: "Ada", phoneDigits: "7185550100" },
    }),
    record({
      collection: "customers",
      id: "c2",
      data: { name: "Bea", phoneDigits: "7185550199", mobileDigits: "9175550101" },
    }),
    record({
      collection: "customers",
      id: "c3",
      data: { name: "Cy", phoneDigits: "2015550100" },
      deleted_at: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  const exact = await findCustomers(pool, { digits: "9175550101" });
  assert.equal(exact.customers[0].id, "c2");
  const prefix = await findCustomers(pool, { prefix: "718555", limit: 8 });
  assert.deepEqual(prefix.customers.map((customer) => customer.id), ["c1", "c2"]);
  const named = await findCustomers(pool, { namePrefix: "B", limit: 8 });
  assert.deepEqual(named.customers.map((customer) => customer.name), ["Bea"]);
});
