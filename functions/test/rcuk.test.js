const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRcukRentalPayload,
  mapRentalPackage,
  normalizeRcukSimNumber,
  toFlag,
} = require("../src/rcuk");

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
  assert.equal(payload.Notes, "+15551234567");
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
  assert.equal(payload.end_date, undefined);
});
