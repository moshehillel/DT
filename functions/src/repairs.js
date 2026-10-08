function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

// Pull a usable lookup value out of whatever the caller sent. Handles SIP URIs
// like "sip:18456370687@69.42.172.203" by keeping only the user part before "@"
// so the host/IP digits don't get welded onto the phone number.
function lookupDigits(value) {
  const user = String(value || "").replace(/^sips?:/i, "").split("@")[0];
  return digitsOnly(user);
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeReportDoc(snapshot) {
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    ...data,
    details: data.details || {},
  };
}

function buildRepairMessage(report) {
  const status = report.details.status || "Received";
  const ticketNumber = report.details.ticketNumber || "";
  const model = report.details.model || "your device";
  const paymentStatus = report.details.paymentStatus || "Not paid";
  const dueDate = report.details.dueDate ? ` Expected ready date is ${report.details.dueDate}.` : "";
  const paidMessage = paymentStatus === "Paid"
    ? "Payment is marked paid."
    : "Payment is not marked paid yet.";
  const ticketPart = ticketNumber
    ? `Repair ticket ${ticketNumber} for ${model}`
    : `Your ${model} repair`;

  return `${ticketPart} status is ${status}. ${paidMessage}${dueDate}`;
}

// Confirmation text sent when a repair is accepted (received) in store.
function buildRepairReceivedMessage(report) {
  const details = report.details || {};
  const model = details.model || "device";
  const parts = [`Diamant Telecom: we received your ${model} for repair.`];

  if (details.ticketNumber) parts.push(`Ticket #${details.ticketNumber}.`);
  if (details.damage) parts.push(`Issue: ${details.damage}.`);
  if (details.dueDate) parts.push(`Estimated ready: ${details.dueDate}.`);
  parts.push(details.paymentStatus === "Paid" ? "Payment: paid, thank you." : "Payment: not paid yet.");
  parts.push("We'll text you when it's ready.");

  return parts.join(" ");
}

function phoneLookupVariants(digits) {
  const variants = new Set([digits]);
  if (digits.length === 11 && digits.startsWith("1")) {
    variants.add(digits.slice(1));
  } else if (digits.length === 10) {
    variants.add(`1${digits}`);
  }
  return Array.from(variants);
}

// Tickets are 100001 and up. On the phone and at the counter the "100" is
// noise, so a customer keys 185 for ticket 100185. Keep the raw digits too:
// an older ticket may actually be stored as 185.
function ticketLookupCandidates(digits) {
  const candidates = new Set([digits]);
  if (digits.length > 0 && digits.length < 6) {
    const value = Number.parseInt(digits, 10);
    if (Number.isFinite(value) && value > 0) {
      candidates.add(String(value));
      if (value < 100000) candidates.add(String(100000 + value));
    }
  }
  return Array.from(candidates);
}

function reportLookupDigits(report) {
  return new Set([
    digitsOnly(report.ticketDigits),
    digitsOnly(report.customerPhoneDigits),
    digitsOnly(report.details?.ticketDigits),
    digitsOnly(report.details?.ticketNumber),
    digitsOnly(report.details?.ticketNumberWas),
    ...(report.ticketDigitsAll || []).map(digitsOnly),
    ...(report.details?.ticketDigitsAll || []).map(digitsOnly),
  ].filter(Boolean));
}

// Exact match on what the caller entered beats a short number that was
// expanded to a 6-digit ticket (185 → 100185). Otherwise the newest repair wins.
function lookupRank(report, digits) {
  const exact = reportLookupDigits(report).has(digits) ? 1 : 0;
  return exact * 1e15 + toMillis(report.createdAt);
}

async function findRepairByLookup(db, lookupValue) {
  const digits = lookupDigits(lookupValue);
  if (!digits) return null;

  const phoneCandidates = phoneLookupVariants(digits);
  const ticketCandidates = ticketLookupCandidates(digits);
  const reports = db.collection("reports");

  // Each query stands alone. One missing index used to reject the whole
  // lookup, so the phone line said the repair did not exist.
  const queries = [
    reports
      .where("type", "==", "repair")
      .where("customerPhoneDigits", "in", phoneCandidates)
      .orderBy("createdAt", "desc")
      .limit(5),
    reports.where("ticketDigits", "in", ticketCandidates).limit(10),
    // The number printed on the phone, including one this repair has since
    // moved off of. array-contains-any needs no orderBy, so it does not depend
    // on the composite index that took the whole lookup down with it.
    reports.where("ticketDigitsAll", "array-contains-any", ticketCandidates).limit(10),
    reports.where("details.ticketNumber", "in", ticketCandidates).limit(10),
    reports.where("details.ticketDigits", "in", ticketCandidates).limit(10),
    reports.where("details.ticketNumberWas", "in", ticketCandidates).limit(10),
  ];

  const settled = await Promise.all(queries.map(async (query) => {
    try {
      return await query.get();
    } catch (error) {
      return error;
    }
  }));

  const snapshots = settled.filter((result) => result && Array.isArray(result.docs));
  if (!snapshots.length) {
    const failure = settled.find((result) => result instanceof Error);
    throw failure || new Error("Repair lookup failed");
  }

  const seen = new Set();
  const matches = [];
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const report = normalizeReportDoc(doc);
      if (report.type && report.type !== "repair") continue;
      if (!report.id || seen.has(report.id)) continue;
      seen.add(report.id);
      matches.push(report);
    }
  }

  matches.sort((left, right) => lookupRank(right, digits) - lookupRank(left, digits));
  return matches[0] || null;
}

module.exports = {
  buildRepairMessage,
  buildRepairReceivedMessage,
  digitsOnly,
  findRepairByLookup,
  normalizeReportDoc,
  ticketLookupCandidates,
};
