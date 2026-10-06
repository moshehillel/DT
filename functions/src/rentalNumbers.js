// Chasing the numbers RCUK allocates to a rental.
//
// RCUK does not hand out a CLI the moment a SIM is activated. How long it takes
// depends on how far away the trip is: a rental starting next week gets its
// numbers about five days before the start date, a rental starting tomorrow
// gets them within a couple of minutes. So there is no point asking straight
// away for a trip a month out, and no point waiting a month for one starting
// today.
//
// Both cases end at the same place: the numbers land on the report and the
// customer is told. This module holds the timing rules; index.js owns the
// Firestore job and the RCUK/notification calls.

// RCUK allocates numbers this many days before the rental starts.
const RENTAL_NUMBER_LEAD_DAYS = 5;
// Inside the allocation window: how long to leave RCUK alone after activating,
// and the ladder of waits between the tries after that.
const RENTAL_NUMBER_FIRST_DELAY_MS = 30000;
const RENTAL_NUMBER_RETRY_DELAY_MS = 60000;
// A rental starting today usually has its numbers within a couple of minutes,
// so the first tries are a minute apart. When those come back empty the wait
// stretches to half a day and then a day: RCUK does sometimes allocate hours
// late, and giving up after three minutes threw those rentals away — while
// asking every minute for a day would be 1,440 calls for one rental.
const RENTAL_NUMBER_LONG_RETRY_DELAYS_MS = [12 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
// Every wait between one ask and the next, in order.
const RENTAL_NUMBER_RETRY_LADDER_MS = [
  RENTAL_NUMBER_RETRY_DELAY_MS,
  RENTAL_NUMBER_RETRY_DELAY_MS,
  ...RENTAL_NUMBER_LONG_RETRY_DELAYS_MS,
];
// Five asks in all: three quick ones, then +12h, then +24h. If RCUK still has
// nothing after that, a human is told.
const RENTAL_NUMBER_MAX_ATTEMPTS = RENTAL_NUMBER_RETRY_LADDER_MS.length + 1;
// Hour of the day (in the store's time zone) the chase starts for a rental that
// was too far out to ask about when it was created.
const RENTAL_NUMBER_NOTICE_HOUR = 10;

// How far `timeZone` is from UTC at `date`, in milliseconds. Formatting the
// instant in the zone and reading it back as if it were UTC gives the offset,
// which is the only way to get 10:00 New York time as a real instant without
// pulling in a date library.
function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Some locales render midnight as hour 24.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

// "2026-09-14" at 10:00 in the store's zone, as a real instant.
function zonedDateTimeToUtc(dateString, hour, timeZone) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offset = timeZoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offset);
}

function shiftDateString(dateString, days) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// The day RCUK is expected to have numbers for a rental starting `startDate`.
function allocationWindowDate(startDate) {
  return shiftDateString(startDate, -RENTAL_NUMBER_LEAD_DAYS);
}

// When to make the first ask, and whether the wait is minutes or weeks.
//
// "scheduled" means the trip is far enough out that RCUK has not allocated
// anything yet — say so on screen rather than pretending the numbers are late.
// "immediate" means we are inside the window, so the retry ladder starts now.
function planRentalNumberChase({ startDate, now = new Date(), timeZone = "America/New_York" } = {}) {
  const soon = new Date(now.getTime() + RENTAL_NUMBER_FIRST_DELAY_MS);
  const windowDate = allocationWindowDate(startDate);
  const windowOpensAt = windowDate ? zonedDateTimeToUtc(windowDate, RENTAL_NUMBER_NOTICE_HOUR, timeZone) : null;

  // No usable start date, or the window is already open (or opens before we
  // would have asked anyway): chase it now.
  if (!windowOpensAt || windowOpensAt <= soon) {
    return { mode: "immediate", firstAttemptAt: soon, windowDate };
  }
  return { mode: "scheduled", firstAttemptAt: windowOpensAt, windowDate };
}

// When to make the next ask, given how many have been made already. Past the
// end of the ladder the last wait repeats, so a caller that keeps going can
// never fall back to asking every minute.
function retryAt(attempt = 1, now = new Date()) {
  const step = Math.min(Math.max(Number(attempt) || 1, 1), RENTAL_NUMBER_RETRY_LADDER_MS.length);
  return new Date(now.getTime() + RENTAL_NUMBER_RETRY_LADDER_MS[step - 1]);
}

// RCUK answers "no" rather than blank for an add-on the customer didn't buy.
function formatExtraNumber(value) {
  const text = String(value || "").trim();
  return text && text.toLowerCase() !== "no" ? text : "";
}

// What the customer is told once RCUK has allocated. One body for both channels:
// it is texted as written and read aloud on a voice call, so no punctuation the
// ear cannot follow.
//
// Takes one line or several. A family renting four SIMs is four rentals on one
// card and one phone number — four texts would be bad and four phone calls
// would be worse, so the whole batch goes out as one message, each SIM named by
// the last four digits printed on the card the customer is holding.
function buildRentalNumbersMessage(rentals) {
  const lines = (Array.isArray(rentals) ? rentals : [rentals]).filter((line) => line && line.cli);

  if (lines.length <= 1) {
    const line = lines[0] || {};
    const parts = ["Diamant Telecom: your rental phone number is ready."];
    if (line.cli) parts.push(`Your number is ${line.cli}.`);
    const us = formatExtraNumber(line.usDdi);
    if (us) parts.push(`Your US number is ${us}.`);
    const israel = formatExtraNumber(line.ilDdi);
    if (israel) parts.push(`Your Israel number is ${israel}.`);
    parts.push("Safe travels, and call us if you need anything.");
    return parts.join(" ");
  }

  const parts = [`Diamant Telecom: your ${lines.length} rental phone numbers are ready.`];
  lines.forEach((line, index) => {
    const last4 = String(line.simNumber || "").replace(/\D/g, "").slice(-4);
    const extras = [
      formatExtraNumber(line.usDdi) && `US number ${formatExtraNumber(line.usDdi)}`,
      formatExtraNumber(line.ilDdi) && `Israel number ${formatExtraNumber(line.ilDdi)}`,
    ].filter(Boolean);
    const label = last4 ? `SIM ending ${last4}` : `Line ${index + 1}`;
    parts.push(`${label}: ${line.cli}${extras.length ? `, ${extras.join(", ")}` : ""}.`);
  });
  parts.push("Safe travels, and call us if you need anything.");
  return parts.join(" ");
}

// Digits one at a time, so the voice reads "0 7 3 8" and not "seven billion".
function speakDigits(value) {
  return String(value || "").replace(/\D/g, "").split("").join(" ");
}

// What the voice call says — deliberately not what the text says. A number read
// down the phone has to come digit by digit with a beat in front of it, and the
// whole thing is said three times (see sendVoiceCall) because the person on the
// other end is looking for a pen.
function buildRentalNumbersVoiceMessage(rentals) {
  const lines = (Array.isArray(rentals) ? rentals : [rentals]).filter((line) => line && line.cli);
  if (!lines.length) return "";

  const parts = [lines.length > 1
    ? `Diamant Telecom calling with your ${lines.length} rental phone numbers.`
    : "Diamant Telecom calling with your rental phone number."];

  lines.forEach((line, index) => {
    if (lines.length > 1) {
      const last4 = String(line.simNumber || "").replace(/\D/g, "").slice(-4);
      parts.push(last4 ? `For the SIM ending ${speakDigits(last4)}.` : `For line ${index + 1}.`);
    }
    // The comma is the beat: without it the first digit runs into the sentence.
    parts.push(`Your number is, ${speakDigits(line.cli)}.`);
    const us = formatExtraNumber(line.usDdi);
    if (us) parts.push(`Your US number is, ${speakDigits(us)}.`);
    const israel = formatExtraNumber(line.ilDdi);
    if (israel) parts.push(`Your Israel number is, ${speakDigits(israel)}.`);
  });

  return parts.join(" ");
}

// A rental worth chasing: live on RCUK, no numbers yet, not already closed.
function rentalNeedsNumbers(report) {
  const details = report?.details || {};
  if (report?.type !== "rental") return false;
  if (!details.rentalId) return false;
  if (details.cli) return false;
  if (details.returnedAt) return false;
  if (["Returned", "Cancelled"].includes(details.rentalStatus || "")) return false;
  return true;
}

// Did the customer buy the US DDI? The rental form writes "Yes"/"No" onto the
// report when it is filed, so this is what was ordered, not what has arrived.
function wantsUsDdi(details) {
  return String(details?.usaNumber || "").trim().toLowerCase() === "yes";
}

// What RCUK still owes this rental. RCUK does not always hand the set back at
// once: the UK CLI can land while the US DDI sits at "No" for another minute or
// an hour. Both the chase and the Get numbers button used to stop asking the
// moment a CLI existed, so a US number that came second was never collected —
// the rental kept the UK number and nothing else, and pressing Get numbers
// again short-circuited on the CLI already on the report.
function numbersOutstanding(details) {
  if (!details?.cli) return true;
  return wantsUsDdi(details) && !details.usDdi;
}

module.exports = {
  RENTAL_NUMBER_RETRY_LADDER_MS,
  RENTAL_NUMBER_FIRST_DELAY_MS,
  RENTAL_NUMBER_LEAD_DAYS,
  RENTAL_NUMBER_MAX_ATTEMPTS,
  RENTAL_NUMBER_NOTICE_HOUR,
  RENTAL_NUMBER_RETRY_DELAY_MS,
  allocationWindowDate,
  buildRentalNumbersMessage,
  buildRentalNumbersVoiceMessage,
  planRentalNumberChase,
  numbersOutstanding,
  retryAt,
  rentalNeedsNumbers,
  shiftDateString,
  speakDigits,
  wantsUsDdi,
  zonedDateTimeToUtc,
};
