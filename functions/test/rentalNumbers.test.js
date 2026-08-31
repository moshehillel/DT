const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RENTAL_NUMBER_FIRST_DELAY_MS,
  allocationWindowDate,
  buildRentalNumbersMessage,
  buildRentalNumbersVoiceMessage,
  planRentalNumberChase,
  rentalNeedsNumbers,
  shiftDateString,
  speakDigits,
  zonedDateTimeToUtc,
} = require("../src/rentalNumbers");

const TZ = "America/New_York";

test("allocationWindowDate lands five days before the start, across a month end", () => {
  assert.equal(allocationWindowDate("2026-09-20"), "2026-09-15");
  assert.equal(allocationWindowDate("2026-03-02"), "2026-02-25");
  assert.equal(allocationWindowDate(""), "");
});

test("shiftDateString does not drift over a DST change", () => {
  // 8 Mar 2026 is the US spring-forward. Plain local-date arithmetic loses an
  // hour here and can come back a day early.
  assert.equal(shiftDateString("2026-03-10", -5), "2026-03-05");
  assert.equal(shiftDateString("2026-11-03", -5), "2026-10-29");
});

test("zonedDateTimeToUtc reads 10:00 New York as the right instant on both sides of DST", () => {
  assert.equal(zonedDateTimeToUtc("2026-07-01", 10, TZ).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(zonedDateTimeToUtc("2026-01-05", 10, TZ).toISOString(), "2026-01-05T15:00:00.000Z");
});

test("a trip more than five days out waits for the allocation window", () => {
  const now = new Date("2026-07-01T16:00:00Z");
  const plan = planRentalNumberChase({ startDate: "2026-08-01", now, timeZone: TZ });
  assert.equal(plan.mode, "scheduled");
  assert.equal(plan.windowDate, "2026-07-27");
  assert.equal(plan.firstAttemptAt.toISOString(), "2026-07-27T14:00:00.000Z");
});

test("a trip inside the window is chased thirty seconds after activation", () => {
  const now = new Date("2026-07-01T16:00:00Z");
  const plan = planRentalNumberChase({ startDate: "2026-07-03", now, timeZone: TZ });
  assert.equal(plan.mode, "immediate");
  assert.equal(plan.firstAttemptAt.getTime(), now.getTime() + RENTAL_NUMBER_FIRST_DELAY_MS);
});

test("a window that opens within the next thirty seconds is treated as open", () => {
  // 10:00 New York on the window date, ten seconds away: waiting for it would
  // schedule a job behind the retry that is about to run anyway.
  const now = new Date("2026-07-27T13:59:50Z");
  const plan = planRentalNumberChase({ startDate: "2026-08-01", now, timeZone: TZ });
  assert.equal(plan.mode, "immediate");
});

test("a rental with no start date is chased now rather than never", () => {
  const now = new Date("2026-07-01T16:00:00Z");
  const plan = planRentalNumberChase({ startDate: "", now, timeZone: TZ });
  assert.equal(plan.mode, "immediate");
});

test("buildRentalNumbersMessage names only the numbers that exist", () => {
  const both = buildRentalNumbersMessage({ cli: "+447700900123", usDdi: "+15551234567" });
  assert.match(both, /\+447700900123/);
  assert.match(both, /US number is \+15551234567/);

  // RCUK answers "no" rather than blank when a US number wasn't bought.
  const ukOnly = buildRentalNumbersMessage({ cli: "+447700900123", usDdi: "no" });
  assert.doesNotMatch(ukOnly, /US number/);
});

test("rentalNeedsNumbers only picks live rentals that are still missing a number", () => {
  const live = { type: "rental", details: { rentalId: "R1", startDate: "2026-07-03" } };
  assert.equal(rentalNeedsNumbers(live), true);
  assert.equal(rentalNeedsNumbers({ ...live, details: { ...live.details, cli: "+447700900123" } }), false);
  assert.equal(rentalNeedsNumbers({ ...live, details: { ...live.details, rentalStatus: "Cancelled" } }), false);
  assert.equal(rentalNeedsNumbers({ ...live, details: { ...live.details, returnedAt: "2026-07-10" } }), false);
  // Israel/Local rentals never go to RCUK, so they have no rental ID to chase.
  assert.equal(rentalNeedsNumbers({ type: "rental", details: {} }), false);
  assert.equal(rentalNeedsNumbers({ type: "sale", details: { rentalId: "R1" } }), false);
});

test("four SIMs on one card become one message, not four", () => {
  const body = buildRentalNumbersMessage([
    { simNumber: "89441000301234564567", cli: "+447700900111", usDdi: "+15551110000" },
    { simNumber: "89441000301234568901", cli: "+447700900222", usDdi: "no" },
    { simNumber: "", cli: "+447700900333", ilDdi: "+972501234567" },
  ]);
  assert.match(body, /your 3 rental phone numbers are ready/);
  assert.match(body, /SIM ending 4567: \+447700900111, US number \+15551110000\./);
  // The middle line bought no US number, so it must not be offered one.
  assert.match(body, /SIM ending 8901: \+447700900222\./);
  // No SIM number recorded still needs something the customer can match up.
  assert.match(body, /Line 3: \+447700900333, Israel number \+972501234567\./);
});

test("a batch where only one line has numbers reads as a single rental", () => {
  const body = buildRentalNumbersMessage([{ simNumber: "89441000301234564567", cli: "+447700900111" }]);
  assert.match(body, /your rental phone number is ready/);
  assert.doesNotMatch(body, /SIM ending/);
});

test("the voice message spaces the digits so they can be written down", () => {
  const body = buildRentalNumbersVoiceMessage([
    { simNumber: "89441000304842716785", cli: "07384236628", usDdi: "19177300280" },
  ]);
  assert.match(body, /Your number is, 0 7 3 8 4 2 3 6 6 2 8\./);
  assert.match(body, /Your US number is, 1 9 1 7 7 3 0 0 2 8 0\./);
  // The text's sign-off would be tedious said three times.
  assert.doesNotMatch(body, /Safe travels/);
});

test("the voice message names each SIM when there is more than one", () => {
  const body = buildRentalNumbersVoiceMessage([
    { simNumber: "89441000301234564567", cli: "07384236628" },
    { simNumber: "89441000301234568901", cli: "07384236629" },
  ]);
  assert.match(body, /your 2 rental phone numbers/);
  assert.match(body, /For the SIM ending 4 5 6 7\./);
  assert.match(body, /For the SIM ending 8 9 0 1\./);
});

test("speakDigits keeps only digits, so a formatted number still reads cleanly", () => {
  assert.equal(speakDigits("+1 (917) 730-0280"), "1 9 1 7 7 3 0 0 2 8 0");
  assert.equal(speakDigits(""), "");
});

test("nothing to say when RCUK gave no number", () => {
  assert.equal(buildRentalNumbersVoiceMessage([{ cli: "" }]), "");
});
