const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRcukRentalPayload,
  isRcukFailureBody,
  mapRentalPackage,
  normalizeRcukSimNumber,
  toFlag,
} = require("../src/rcuk");

// RCUK answers HTTP 200 on failure, so the body is the only signal. Getting this
// wrong made a rejected SIM look checked and blocked activation entirely.
test("isRcukFailureBody catches failures reported at HTTP 200", () => {
  assert.equal(isRcukFailureBody({ status: "Failed", message: "Invalid SIM Entered" }), true);
  assert.equal(isRcukFailureBody({ Status: "ERROR" }), true);
  assert.equal(isRcukFailureBody({ status: "rejected" }), true);
});

test("isRcukFailureBody leaves successful and unknown statuses alone", () => {
  assert.equal(isRcukFailureBody({ status: "Success" }), false);
  assert.equal(isRcukFailureBody({ status: "Active", rental_id: "123" }), false);
  assert.equal(isRcukFailureBody({ rental_id: "123" }), false);
  assert.equal(isRcukFailureBody({}), false);
  assert.equal(isRcukFailureBody(null), false);
});

test("normalizeRcukSimNumber prefixes short SIM codes", () => {
  assert.equal(normalizeRcukSimNumber("000301234567890"), "89441000301234567890");
  assert.equal(normalizeRcukSimNumber("0061234567890"), "8944110061234567890");
});

test("mapRentalPackage maps voice and data labels", () => {
  assert.equal(mapRentalPackage("Voice and data"), "v&d");
  assert.equal(mapRentalPackage("data only"), "data");
  assert.equal(mapRentalPackage("Voice"), "voice");
});

test("toFlag accepts common truthy values", () => {
  assert.equal(toFlag("yes"), 1);
  assert.equal(toFlag("false"), 0);
  assert.equal(toFlag(""), 0);
});

test("buildRcukRentalPayload maps daily rental fields", () => {
  const payload = buildRcukRentalPayload({
    simNumber: "000301234567890",
    service_type: "Voice and data",
    start_date: "2026-06-01",
    end_date: "2026-06-05",
    uk_days: 3,
    eu_days: 2,
    wts_days: 0,
    addSms: true,
    usaNumber: "yes",
    customerPhone: "+15551234567",
  });

  assert.equal(payload.sim_number, "89441000301234567890");
  assert.equal(payload.rental_type, "daily");
  assert.equal(payload.rental_package, "v&d");
  assert.equal(payload.end_date, "2026-06-05");
  assert.equal(payload.sms, 1);
  assert.equal(payload.us_ddi, 1);
  // Lowercase `notes` — RCUK rejects the capitalised key as invalid schema.
  assert.equal(payload.notes, "+15551234567");
  assert.equal(payload.tp_days, 0);
});

test("buildRcukRentalPayload maps monthly rental fields", () => {
  const payload = buildRcukRentalPayload({
    sim_number: "89441000301234567890",
    rental_type: "monthly",
    no_of_months: 2,
    start_date: "2026-06-01",
  });

  assert.equal(payload.rental_type, "monthly");
  assert.equal(payload.no_of_months, 2);
  // RCUK requires end_date and no_of_months on EVERY request, so a monthly
  // rental still sends end_date — empty, but present.
  assert.equal(payload.end_date, "");
});
