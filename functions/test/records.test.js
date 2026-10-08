const test = require("node:test");
const assert = require("node:assert/strict");
const { deepMerge, nextData, normalizeOps, permitted } = require("../src/records");
const { stockFieldsFor } = require("../src/inventoryPg");

const staff = { uid: "u1", admin: false };
const boss = { uid: "u2", admin: true };
const set = (collection, data = { a: 1 }) => ({ collection, id: "x", type: "set", data });
const del = (collection) => ({ collection, id: "x", type: "delete" });

test("merge folds nested maps and replaces arrays, like Firestore", () => {
  const merged = deepMerge(
    { name: "A", details: { status: "Open", notes: ["one"] }, tags: [1, 2] },
    { details: { status: "Done", notes: ["two"] }, tags: [3] },
  );
  assert.deepEqual(merged, { name: "A", details: { status: "Done", notes: ["two"] }, tags: [3] });
});

test("a product save never carries stock and keeps what is stored", () => {
  const existing = { name: "Cable", price: "5", stock: { Monroe: { quantity: 3, imeis: [] } }, quantity: 3, imeis: [] };
  const next = nextData(existing, { collection: "products", type: "set", data: { name: "USB-C cable", stock: {}, quantity: 0, imeis: [] } });
  assert.deepEqual(next, { name: "USB-C cable", price: "5", stock: { Monroe: { quantity: 3, imeis: [] } }, quantity: 3, imeis: [] });
});

test("set replaces a record outside products", () => {
  assert.deepEqual(nextData({ a: 1, b: 2 }, set("reports", { a: 5 })), { a: 5 });
});

test("signed-out saves are refused everywhere", () => {
  assert.equal(permitted({ uid: "" }, null, set("reports")), false);
});

test("staff permissions match firestore.rules", () => {
  const expectations = [
    ["appState", true, true, true],
    ["reports", true, true, false],
    ["phoneOrders", true, true, true],
    ["orderHandlers", true, true, false],
    ["products", true, true, false],
    ["customers", true, true, false],
    ["rentalPhones", true, true, false],
    ["stockWaitlist", true, true, true],
    ["notificationLogs", true, false, false],
    ["passwordResetRequests", true, false, false],
    ["repairTickets", true, false, false],
    ["employees", false, false, false],
    ["inventoryPhones", false, false, false],
    ["stockMovements", false, false, false],
    ["inventoryBalances", false, false, false],
    ["cardRefunds", false, false, false],
  ];
  for (const [collection, create, update, remove] of expectations) {
    assert.equal(permitted(staff, null, set(collection)), create, `${collection} create`);
    assert.equal(permitted(staff, { a: 0 }, set(collection)), update, `${collection} update`);
    assert.equal(permitted(staff, { a: 0 }, del(collection)), remove, `${collection} delete`);
  }
});

test("admins can do what the rules let admins do, and no more", () => {
  assert.equal(permitted(boss, { a: 0 }, del("reports")), true);
  assert.equal(permitted(boss, null, set("employees")), true);
  assert.equal(permitted(boss, { a: 0 }, set("repairTickets")), false);
  assert.equal(permitted(boss, null, set("stockMovements")), false);
  assert.equal(permitted(boss, null, set("somethingElse")), false);
});

test("pending list: staff update only unclaimed rows and remove handled ones", () => {
  assert.equal(permitted(staff, null, set("pendingReports")), false);
  assert.equal(permitted(staff, { claimedBy: "" }, set("pendingReports")), true);
  assert.equal(permitted(staff, {}, set("pendingReports")), true);
  assert.equal(permitted(staff, { claimedBy: "Dana" }, set("pendingReports")), false);
  assert.equal(permitted(staff, { claimedBy: "Dana" }, del("pendingReports")), true);
  assert.equal(permitted(staff, { servedBy: "Avi" }, del("pendingReports")), true);
  assert.equal(permitted(staff, { source: "shopify_pos" }, del("pendingReports")), true);
  assert.equal(permitted(staff, { claimedBy: "" }, del("pendingReports")), false);
  assert.equal(permitted(boss, { claimedBy: "Dana" }, set("pendingReports")), true);
});

test("bad saves are refused before anything is touched", () => {
  assert.throws(() => normalizeOps([]), /Nothing to save/);
  assert.throws(() => normalizeOps([{ collection: "nope", id: "1", type: "set", data: {} }]), /Unknown collection/);
  assert.throws(() => normalizeOps([{ collection: "reports", id: "a/b", type: "set", data: {} }]), /id is not valid/);
  assert.throws(() => normalizeOps([{ collection: "reports", id: "1", type: "set" }]), /no data/);
  assert.deepEqual(normalizeOps([{ collection: "reports", id: "1", type: "delete", data: { x: 1 } }]), [
    { collection: "reports", id: "1", type: "delete", data: null },
  ]);
});

test("stock fields for the registers come from PostgreSQL and keep known stores", () => {
  const phone = { requiresImei: true, stock: { Monroe: { quantity: 1, imeis: ["1"] }, Brooklyn: { quantity: 0, imeis: [] } } };
  assert.deepEqual(stockFieldsFor(phone, { levels: {}, imeis: { Monroe: ["1", "2"] } }), {
    stock: { Monroe: { quantity: 2, imeis: ["1", "2"] }, Brooklyn: { quantity: 0, imeis: [] } },
    quantity: 2,
    imeis: ["1", "2"],
    location: "",
  });
  const cable = { stock: { Monroe: { quantity: 4, imeis: [] } } };
  assert.deepEqual(stockFieldsFor(cable, { levels: { Monroe: 3, Lakewood: 1 }, imeis: {} }), {
    stock: { Monroe: { quantity: 3, imeis: [] }, Lakewood: { quantity: 1, imeis: [] } },
    quantity: 4,
    imeis: [],
    location: "",
  });
});
