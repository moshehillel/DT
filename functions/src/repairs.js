function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
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
  const lookupDigits = digitsOnly(lookupValue);
  if (!lookupDigits) return null;

  const phoneCandidates = phoneLookupVariants(lookupDigits);

  const queries = [
    db.collection("reports")
      .where("type", "==", "repair")
      .where("customerPhoneDigits", "in", phoneCandidates)
      .orderBy("createdAt", "desc")
      .limit(1),
    db.collection("reports")
      .where("type", "==", "repair")
      .where("ticketDigits", "==", lookupDigits)
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
  digitsOnly,
  findRepairByLookup,
  normalizeReportDoc,
};
