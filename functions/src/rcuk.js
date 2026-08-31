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

// RCUK answers HTTP 200 even when the operation failed, putting the real outcome
// in the body: {"status":"Failed","message":"Invalid SIM Entered"}. Judging the
// call by HTTP status alone read those as success — a rejected SIM looked checked,
// and a failed activation looked "submitted" with no rental ID. Only an explicit
// failure word counts, so whatever wording RCUK uses for success still passes.
const RCUK_FAILURE_STATUSES = ["failed", "fail", "error", "declined", "rejected", "invalid"];

function isRcukFailureBody(data) {
  const status = String(data?.status ?? data?.Status ?? "").trim().toLowerCase();
  return RCUK_FAILURE_STATUSES.includes(status);
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
    // RCUK's field is lowercase `notes`; sending `Notes` fails schema validation.
    notes: payload.customer_phone || payload.customerPhone || payload.notes || "",
    // RCUK's schema requires BOTH end_date and no_of_months present on every
    // request (a working reference always sends no_of_months: 0 for daily).
    // Omitting either one is rejected as "invalid request body".
    end_date: payload.end_date || "",
    no_of_months: isMonthly ? numberOrZero(payload.no_of_months) : 0,
  };

  return rcukPayload;
}

function extractRentalId(data) {
  return data.rental_id
    || data.rentalId
    || data.reactivated_rental_id
    || data.id
    || data.ID
    || data.data?.rental_id
    || data.data?.rentalId
    || data.data?.ID
    || data.rental_data?.rental_id
    || data.rental_data?.id
    || data.rental_data?.ID
    || "";
}

// RCUK's get-rental answers with a LIST, not an object:
//
//   { "code": 200, "rentals": [ { "ID": 47089, "CLI": "07384236628", ... } ] }
//
// Reading only `rental_data`/`data` fell through to the top-level body, which
// has no CLI on it, so every lookup came back "pending" with the number sitting
// right there in the response. That is why rental 47089 was chased three times
// and given up on while RCUK had had its number from the first second.
function rentalLookupRow(data) {
  if (!data || typeof data !== "object") return {};
  for (const candidate of [data.rentals, data.rental_data, data.data]) {
    if (Array.isArray(candidate)) {
      if (candidate.length) return candidate[0] || {};
      continue;
    }
    if (candidate && typeof candidate === "object") return candidate;
  }
  return data;
}

// RCUK writes "No" — or "0" — into the field for an add-on the customer did not
// buy, so those are absences, not numbers.
function pickRentalNumber(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    if (["no", "none", "0"].includes(text.toLowerCase())) continue;
    return text;
  }
  return "";
}

function normalizeRentalLookup(data) {
  const row = rentalLookupRow(data);
  const cli = pickRentalNumber(row.cli, row.CLI, row.phone_number);
  const usDdi = pickRentalNumber(row.us_ddi, row.usDDI, row.usa_number, row.us_number);
  const ilDdi = pickRentalNumber(row.il_ddi, row.ilDDI, row.israel_number);

  return {
    rentalId: String(extractRentalId(data) || extractRentalId(row) || ""),
    cli,
    usDdi,
    ilDdi,
    status: row.status || row.Status || "",
    pending: !cli && !usDdi,
    raw: data,
  };
}

module.exports = {
  buildRcukRentalPayload,
  extractRentalId,
  normalizeRentalLookup,
  pickRentalNumber,
  rentalLookupRow,
  digitsOnly,
  isRcukFailureBody,
  mapRentalPackage,
  normalizeRcukSimNumber,
  numberOrZero,
  toFlag,
};
