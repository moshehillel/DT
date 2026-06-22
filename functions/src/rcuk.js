function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeRcukSimNumber(value) {
  const digits = digitsOnly(value);
  if (!digits) return "";
  if (digits.startsWith("8944100030") || digits.startsWith("894411006")) return digits;
  if (digits.startsWith("00030")) return `89441${digits}`;
  if (digits.startsWith("006")) return `894411${digits}`;
  return digits;
}

function toFlag(value) {
  if (value === undefined || value === null || value === "") return 0;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "yes", "y", "true", "on"].includes(normalized) ? 1 : 0;
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function mapRentalPackage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["v&d", "voice and data", "voice & data", "voice+data", "both"].includes(normalized)) return "v&d";
  if (["data", "data only"].includes(normalized)) return "data";
  return "voice";
}

function buildRcukRentalPayload(payload) {
  const isMonthly = payload.rental_type
    ? String(payload.rental_type).toLowerCase() === "monthly"
    : Boolean(payload.no_of_months);

  const rcukPayload = {
    sim_number: normalizeRcukSimNumber(payload.sim_number || payload.simNumber),
    country: "UK",
    rental_type: isMonthly ? "monthly" : "daily",
    rental_package: mapRentalPackage(payload.rental_package || payload.service_type),
    start_date: payload.start_date || "",
    uk_days: numberOrZero(payload.uk_days),
    eu_days: numberOrZero(payload.eu_days),
    wts_days: numberOrZero(payload.wts_days),
    tp_days: 0,
    il_ddi: toFlag(payload.il_ddi ?? payload.israel_number ?? payload.il_number),
    us_ddi: toFlag(payload.us_ddi ?? payload.usa_number ?? payload.usaNumber),
    sms: toFlag(payload.sms ?? payload.add_sms ?? payload.addSms),
    Notes: payload.customer_phone || payload.customerPhone || payload.notes || "",
  };

  if (isMonthly) {
    rcukPayload.no_of_months = numberOrZero(payload.no_of_months);
  } else {
    rcukPayload.end_date = payload.end_date || "";
  }

  return rcukPayload;
}

module.exports = {
  buildRcukRentalPayload,
  digitsOnly,
  mapRentalPackage,
  normalizeRcukSimNumber,
  numberOrZero,
  toFlag,
};
