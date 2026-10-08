const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cardShareOf,
  chargedOnCard,
  interpretRefundReply,
  planRefund,
  refundedBeforeLedger,
  refundedOnLedger,
} = require("../src/refunds");

function sale(overrides = {}) {
  return {
    id: "sale-1",
    paymentAmount: "108.88",
    paymentMethod: "Card",
    details: { solaRefNum: "111", payments: [{ method: "Card", amount: "108.88" }] },
    ...overrides,
  };
}

function reserve(ledger, refundId, amount, extra = {}) {
  const plan = planRefund(ledger, { refundId, amount, kind: "sale", ...extra });
  if (plan.action === "reserve") {
    ledger.entries[refundId] = { amount, status: "pending" };
  }
  return plan;
}

test("a split sale only counts its card share", () => {
  const split = sale({
    paymentAmount: "150.00",
    paymentMethod: "Cash + Card",
    details: { payments: [{ method: "Cash", amount: "50.00" }, { method: "Card", amount: "100.00" }] },
  });
  assert.equal(cardShareOf(split), 100);
  assert.equal(cardShareOf({ paymentMethod: "Cash", paymentAmount: "20" }), 0);
  assert.equal(cardShareOf({ paymentMethod: "CC", paymentAmount: "20", details: {} }), 20);
});

test("rentals charged together count the one charge once", () => {
  const rentals = [1, 2, 3].map((n) => ({
    id: `r${n}`,
    paymentMethod: "Card",
    paymentAmount: "60",
    details: { cardRefNum: "222", rentalBatchId: "b1", batchChargeTotal: 180 },
  }));
  assert.equal(chargedOnCard(rentals), 180);
});

test("refunds made before the ledger still count", () => {
  const partlyReturned = sale({
    details: { payments: [{ method: "Card", amount: "108.88" }], refundedByMethod: { Card: "40.00", Cash: "5.00" } },
  });
  assert.equal(refundedBeforeLedger([partlyReturned]), 40);
  const olderReturn = { details: { solaRefundRef: "x", refundMethod: "Card", refundTotal: "60.00" } };
  assert.equal(refundedBeforeLedger([sale()], [olderReturn]), 60);
  const refundedDeposit = { details: { depositStatus: "Refunded", securityDeposit: "25.00" } };
  assert.equal(refundedBeforeLedger([refundedDeposit]), 25);
});

test("a refund over what is left is refused", () => {
  const ledger = { charged: 108.88, refundedBefore: 40, entries: {} };
  const plan = planRefund(ledger, { refundId: "return:a", amount: 70, kind: "sale" });
  assert.equal(plan.action, "refuse");
  assert.match(plan.message, /Only \$68\.88 is left/);
  assert.equal(planRefund(ledger, { refundId: "return:a", amount: 68.88, kind: "sale" }).action, "reserve");
});

test("two registers refunding the same sale can't both get the full amount", () => {
  const ledger = { charged: 108.88, refundedBefore: 0, entries: {} };
  assert.equal(reserve(ledger, "return:register-1", 108.88).action, "reserve");
  const second = reserve(ledger, "return:register-2", 108.88);
  assert.equal(second.action, "refuse");
  assert.match(second.message, /already been refunded/);
});

test("a retry with the same id is answered without refunding again", () => {
  const ledger = {
    charged: 108.88,
    refundedBefore: 0,
    entries: { "return:a": { amount: 108.88, status: "approved", solaRef: "999" } },
  };
  const plan = planRefund(ledger, { refundId: "return:a", amount: 108.88, kind: "sale" });
  assert.equal(plan.action, "repeat");
  assert.equal(plan.entry.solaRef, "999");
});

test("a refund with no answer from Sola blocks a retry until checked", () => {
  const ledger = { charged: 50, refundedBefore: 0, entries: { "return:a": { amount: 50, status: "pending" } } };
  const plan = planRefund(ledger, { refundId: "return:a", amount: 50, kind: "sale" });
  assert.equal(plan.action, "refuse");
  assert.match(plan.message, /Check Sola/);
  assert.equal(refundedOnLedger(ledger), 50);
});

test("a declined refund gives its amount back", () => {
  const ledger = { charged: 50, refundedBefore: 0, entries: { "return:a": { amount: 50, status: "declined" } } };
  assert.equal(refundedOnLedger(ledger), 0);
  assert.equal(planRefund(ledger, { refundId: "return:b", amount: 50, kind: "sale" }).action, "reserve");
  assert.equal(planRefund(ledger, { refundId: "return:a", amount: 50, kind: "sale" }).action, "reserve");
});

test("a deposit goes back once and never more than the deposit", () => {
  const rental = { id: "r1", details: { securityDeposit: "25.00", depositStatus: "Held" } };
  const ledger = { charged: 85, refundedBefore: 0, entries: {} };
  const tooMuch = planRefund(ledger, { refundId: "deposit:r1", amount: 30, kind: "deposit", report: rental });
  assert.equal(tooMuch.action, "refuse");
  assert.equal(planRefund(ledger, { refundId: "deposit:r1", amount: 25, kind: "deposit", report: rental }).action, "reserve");
  const done = { id: "r1", details: { securityDeposit: "25.00", depositStatus: "Refunded" } };
  assert.equal(planRefund(ledger, { refundId: "deposit:r1", amount: 25, kind: "deposit", report: done }).action, "refuse");
});

test("Sola's single-letter answers are read correctly", () => {
  assert.equal(interpretRefundReply(true, { xResult: "A", xStatus: "Approved" }), "approved");
  assert.equal(interpretRefundReply(true, { xResult: "D", xError: "Declined" }), "declined");
  assert.equal(interpretRefundReply(true, { xResult: "E", xError: "Invalid ref" }), "declined");
  assert.equal(interpretRefundReply(false, { message: "Bad gateway" }), "unknown");
  assert.equal(interpretRefundReply(true, {}), "unknown");
});
