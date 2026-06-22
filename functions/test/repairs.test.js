const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRepairMessage } = require("../src/repairs");

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
