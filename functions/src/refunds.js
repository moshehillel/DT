// Card refunds are counted against what the card was actually charged. Each
// card reference has one ledger document; every refund reserves its amount on
// it inside a transaction before Sola is asked, so two registers refunding the
// same sale at once can't hand back more than the card took.

const CENT = 0.005;

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isCardMethod(method) {
  return method === "Card" || method === "CC";
}

// What this one report put on the card.
function cardShareOf(report) {
  const details = report?.details || {};
  const payments = (Array.isArray(details.payments) ? details.payments : []).filter((entry) => entry?.method);
  if (payments.length) {
    return money(payments.filter((entry) => isCardMethod(entry.method))
      .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
  }
  return isCardMethod(report?.paymentMethod) ? money(report?.paymentAmount) : 0;
}

// Several rentals filed together share one charge; batchChargeTotal is that
// single charge, so it is counted once rather than once per SIM.
function chargedOnCard(reports) {
  const batchTotals = new Map();
  let total = 0;
  for (const report of reports) {
    const details = report?.details || {};
    const batchId = details.rentalBatchId;
    if (batchId && Number(details.batchChargeTotal) > 0) {
      batchTotals.set(batchId, money(details.batchChargeTotal));
    } else {
      total += cardShareOf(report);
    }
  }
  for (const value of batchTotals.values()) total += value;
  return money(total);
}

function cardPartOfReturn(returnReport) {
  const details = returnReport?.details || {};
  const payments = Array.isArray(details.refundPayments) ? details.refundPayments : [];
  if (payments.length) {
    return money(payments.filter((entry) => isCardMethod(entry?.method))
      .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
  }
  return isCardMethod(details.refundMethod || returnReport?.paymentMethod)
    ? money(details.refundTotal || Math.abs(Number(returnReport?.paymentAmount) || 0))
    : 0;
}

// Refunds made before the ledger existed. The sale keeps a per-method total;
// older sales only have their return reports, so the larger of the two counts.
function refundedBeforeLedger(reports, returnReports = []) {
  let fromSales = 0;
  for (const report of reports) {
    const details = report?.details || {};
    const byMethod = details.refundedByMethod || {};
    for (const [method, amount] of Object.entries(byMethod)) {
      if (isCardMethod(method)) fromSales += Number(amount) || 0;
    }
    if (details.depositStatus === "Refunded") fromSales += Number(details.securityDeposit) || 0;
  }
  const fromReturns = returnReports
    .filter((entry) => entry?.details?.solaRefundRef)
    .reduce((sum, entry) => sum + cardPartOfReturn(entry), 0);
  return money(Math.max(fromSales, fromReturns));
}

function refundedOnLedger(ledger) {
  const entries = Object.values(ledger?.entries || {});
  const counted = entries
    .filter((entry) => entry?.status === "approved" || entry?.status === "pending")
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  return money((Number(ledger?.refundedBefore) || 0) + counted);
}

// Decides what to do with one refund request against the ledger as it stands.
// Returns { action: "reserve" | "repeat" | "refuse", status, message, entry }.
function planRefund(ledger, request) {
  const { refundId, amount, kind, report } = request;
  const existing = ledger?.entries?.[refundId];
  if (existing?.status === "approved") {
    return { action: "repeat", entry: existing };
  }
  if (existing?.status === "pending") {
    return {
      action: "refuse",
      status: 409,
      message: "This refund is still waiting on an answer from Sola. Check Sola before trying again.",
    };
  }

  if (kind === "deposit") {
    const deposit = money(report?.details?.securityDeposit);
    if (!report) {
      return { action: "refuse", status: 404, message: "Can't find this rental on the card." };
    }
    if (report.details?.depositStatus === "Refunded") {
      return { action: "refuse", status: 409, message: "This deposit has already been refunded." };
    }
    if (amount > deposit + CENT) {
      return { action: "refuse", status: 409, message: `The deposit on this rental is only $${deposit.toFixed(2)}.` };
    }
  }

  const charged = money(ledger?.charged);
  const left = money(charged - refundedOnLedger(ledger));
  if (amount > left + CENT) {
    return {
      action: "refuse",
      status: 409,
      message: left > 0
        ? `Only $${left.toFixed(2)} is left to refund on this card.`
        : "Everything charged on this card has already been refunded.",
    };
  }
  return { action: "reserve" };
}

// Sola's gateway answers with single-letter codes: A approved, D declined,
// E error. Anything else, or no answer at all, is not known to have failed.
function interpretRefundReply(httpOk, data) {
  const result = String(data?.xResult || "").trim().toUpperCase();
  const status = String(data?.xStatus || data?.status || "").trim().toLowerCase();
  if (result === "A" || result === "APPROVED" || status === "approved" || status === "success") return "approved";
  if (result === "D" || result === "E" || status === "declined" || status === "error") return "declined";
  if (!httpOk && (data?.xError || data?.xErrorCode)) return "declined";
  return "unknown";
}

module.exports = {
  cardShareOf,
  chargedOnCard,
  refundedBeforeLedger,
  refundedOnLedger,
  planRefund,
  interpretRefundReply,
  money,
};
