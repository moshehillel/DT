const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRepairMessage, findRepairByLookup, ticketLookupCandidates } = require("../src/repairs");

function readPath(doc, field) {
  return field.split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function matches(doc, filter) {
  const value = readPath(doc, filter.field);
  if (filter.op === "==") return value === filter.value;
  if (filter.op === "in") return filter.value.includes(value);
  if (filter.op === "array-contains") return Array.isArray(value) && value.includes(filter.value);
  if (filter.op === "array-contains-any") {
    return Array.isArray(value) && value.some((entry) => filter.value.includes(entry));
  }
  return false;
}

// Tiny stand-in for the Firestore query chain the lookup builds.
function fakeDb(docs, { failFields = [] } = {}) {
  function query(filters) {
    const failing = filters.some((filter) => failFields.includes(filter.field));
    return {
      where(field, op, value) {
        return query([...filters, { field, op, value }]);
      },
      orderBy() {
        return query(filters);
      },
      limit(count) {
        return {
          get: async () => {
            if (failing) throw new Error(`missing index for ${filters.map((filter) => filter.field).join("+")}`);
            const found = docs.filter((doc) => filters.every((filter) => matches(doc, filter))).slice(0, count);
            return { docs: found.map((data) => ({ id: data.id, data: () => data })) };
          },
        };
      },
      get: async () => {
        if (failing) throw new Error(`missing index for ${filters.map((filter) => filter.field).join("+")}`);
        const found = docs.filter((doc) => filters.every((filter) => matches(doc, filter)));
        return { docs: found.map((data) => ({ id: data.id, data: () => data })) };
      },
    };
  }
  return { collection: () => query([]) };
}

test("buildRepairMessage includes status, ticket, and payment", () => {
  const message = buildRepairMessage({
    details: {
      status: "Ready",
      ticketNumber: "DR-20260617-0001",
      model: "iPhone 13",
      paymentStatus: "Paid",
      dueDate: "2026-06-20",
    },
  });

  assert.match(message, /status is Ready/);
  assert.match(message, /DR-20260617-0001/);
  assert.match(message, /iPhone 13/);
  assert.match(message, /Payment is marked paid/);
  assert.match(message, /2026-06-20/);
});

test("buildRepairMessage works without ticket number", () => {
  const message = buildRepairMessage({
    details: {
      status: "In repair",
      model: "Galaxy S23",
      paymentStatus: "Not paid",
    },
  });

  assert.match(message, /Your Galaxy S23 repair status is In repair/);
  assert.match(message, /Payment is not marked paid yet/);
});

test("short ticket numbers also search the 6-digit form", () => {
  assert.deepEqual(ticketLookupCandidates("185").sort(), ["100185", "185"]);
  assert.deepEqual(ticketLookupCandidates("0195").sort(), ["0195", "100195", "195"]);
  assert.deepEqual(ticketLookupCandidates("100185"), ["100185"]);
});

test("calling in with 185 finds ticket 100185", async () => {
  const db = fakeDb([
    {
      id: "repair-185",
      type: "repair",
      createdAt: "2026-10-07T12:00:00.000Z",
      ticketDigits: "100185",
      ticketDigitsAll: ["100185"],
      customerPhoneDigits: "8455550100",
      details: { ticketNumber: "100185", status: "In repair", model: "iPhone 13" },
    },
  ]);

  const repair = await findRepairByLookup(db, "185");
  assert.equal(repair.id, "repair-185");
  assert.equal(repair.details.ticketNumber, "100185");
});

test("a renumbered repair is still found by the number on the label", async () => {
  const db = fakeDb([
    {
      id: "repair-195",
      type: "repair",
      createdAt: "2026-10-07T15:00:00.000Z",
      ticketDigits: "100220",
      ticketDigitsAll: ["100195", "100220"],
      details: { ticketNumber: "100220", ticketNumberWas: "100195", status: "Received", model: "Galaxy S23" },
    },
  ]);

  const repair = await findRepairByLookup(db, "100195");
  assert.equal(repair.id, "repair-195");
});

test("a failed ticketDigitsAll query does not hide a repair the other queries found", async () => {
  const db = fakeDb([
    {
      id: "repair-185",
      type: "repair",
      createdAt: "2026-10-07T12:00:00.000Z",
      ticketDigits: "100185",
      customerPhoneDigits: "8455550100",
      details: { ticketNumber: "100185", status: "Ready", model: "iPhone 13" },
    },
  ], { failFields: ["ticketDigitsAll"] });

  const repair = await findRepairByLookup(db, "100185");
  assert.equal(repair.id, "repair-185");
});
