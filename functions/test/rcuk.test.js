const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRcukRentalPayload,
  isRcukFailureBody,
  mapRentalPackage,
  normalizeRcukSimNumber,
  normalizeRentalLookup,
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

// The real body RCUK returned for rental 47089 on 30 Aug 2026. The old parser
// read the top-level object, found no CLI, and reported the rental as pending
// while the number sat in rentals[0] — three chase attempts gave up on it.
const RCUK_47089 = {
  code: 200,
  rentals: [{
    ID: 47089,
    network: "Vodafone",
    package: "voice",
    CLI: "07384236628",
    country: "UK",
    rental_type: "Daily",
    start_date: "2026-08-31",
    end_date: "2026-09-03",
    SIM: "89441000304842716785",
    status: "Processing",
    il_ddi: "No",
    us_ddi: "19177300280",
    uk_ddi: "0",
    sms: "No",
  }],
};

test("normalizeRentalLookup reads the numbers out of RCUK's rentals list", () => {
  const result = normalizeRentalLookup(RCUK_47089);
  assert.equal(result.cli, "07384236628");
  assert.equal(result.usDdi, "19177300280");
  assert.equal(result.rentalId, "47089");
  assert.equal(result.status, "Processing");
  assert.equal(result.pending, false);
});

test("normalizeRentalLookup treats \"No\" and \"0\" as no number at all", () => {
  const result = normalizeRentalLookup(RCUK_47089);
  // il_ddi is "No" and uk_ddi is "0": neither is a number to text a customer.
  assert.equal(result.ilDdi, "");
});

test("normalizeRentalLookup still reads the older nested shapes", () => {
  const nested = normalizeRentalLookup({ rental_data: { rental_id: "500", cli: "07000000000" } });
  assert.equal(nested.cli, "07000000000");
  assert.equal(nested.rentalId, "500");

  const flat = normalizeRentalLookup({ ID: "600", CLI: "07111111111" });
  assert.equal(flat.cli, "07111111111");
  assert.equal(flat.rentalId, "600");
});

test("normalizeRentalLookup reports a genuinely unallocated rental as pending", () => {
  const result = normalizeRentalLookup({ code: 200, rentals: [{ ID: 47090, CLI: "", us_ddi: "No" }] });
  assert.equal(result.cli, "");
  assert.equal(result.pending, true);
});

test("normalizeRentalLookup survives an empty list without throwing", () => {
  const result = normalizeRentalLookup({ code: 200, rentals: [] });
  assert.equal(result.cli, "");
  assert.equal(result.pending, true);
});
