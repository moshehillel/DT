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

async function findRepairByLookup(db, lookupValue) {
  const digits = lookupDigits(lookupValue);
  if (!digits) return null;

  const phoneCandidates = phoneLookupVariants(digits);

  const queries = [
    db.collection("reports")
      .where("type", "==", "repair")
      .where("customerPhoneDigits", "in", phoneCandidates)
      .orderBy("createdAt", "desc")
      .limit(1),
    db.collection("reports")
      .where("type", "==", "repair")
      .where("ticketDigits", "==", digits)
      .orderBy("createdAt", "desc")
      .limit(1),
  ];

  const snapshots = await Promise.all(queries.map((query) => query.get()));
  const matches = snapshots
    .flatMap((snapshot) => snapshot.docs.map(normalizeReportDoc))
    .sort((left, right) => toMillis(right.createdAt) - toMillis(left.createdAt));

  return matches[0] || null;
}

module.exports = {
  buildRepairMessage,
  buildRepairReceivedMessage,
  digitsOnly,
  findRepairByLookup,
  normalizeReportDoc,
};
