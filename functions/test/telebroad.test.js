const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTelebroadPendingReport,
  callResultRank,
  classifyCall,
  extractCustomerPhone,
  isAnsweredCall,
  shouldImportCall,
} = require("../src/telebroad");

// Real "Account end" (AccountEndedCalls) shapes captured from live test calls.
// The operator / main service-center line is phone 3839601 (reached via the
// "message or operator" IVR option). A no-answer is only a Missed call when the
// operator line rang — a call abandoned while it only rang a store is ignored.

// Selected operator, it rang the main line (3839601), nobody answered, no
// message left → the missed call the operator should return.
const operatorMissed = {
  callId: "1783386668.111111",
  direction: "incoming",
  status: "missed",
  webhookType: "AccountEndedCalls",
  callerNumber: "18456370687",
  externalCallerId: "18456370687",
  externalCallerName: "WIRELESS CALLER",
  callDuration: 60,
  talkDuration: 0,
  recordingUrl: "https://api.account.telebroad.com/api/v1/recordings/op.mp3",
  cdrs: [
    { status: "answer", callerType: "external", calledType: "ivr", calledNumber: "73626", talkDuration: 60 },
    { status: "noanswer", callerType: "ivr", calledType: "huntgroup", calledNumber: "54344", talkDuration: 0 },
    { status: "cancel", callerType: "huntgroup", calledType: "phone", calledNumber: "3839597", talkDuration: 0 },
    { status: "answer", callerType: "huntgroup", calledType: "ivr", calledNumber: "73890", talkDuration: 30 },
    { status: "noanswer", callerType: "ivr", calledType: "phone", calledNumber: "3839601", talkDuration: 0 },
  ],
};

// Rang only a store's phones and was abandoned — never reached the operator.
// Under the main-line rule this is ignored (no report).
const storeOnlyMissed = {
  ...operatorMissed,
  callId: "1783385416.634431",
  cdrs: [
    { status: "answer", callerType: "external", calledType: "ivr", calledNumber: "73626", talkDuration: 52 },
    { status: "noanswer", callerType: "ivr", calledType: "huntgroup", calledNumber: "54342", talkDuration: 0 },
    { status: "cancel", callerType: "huntgroup", calledType: "phone", calledNumber: "3839593", talkDuration: 0 },
    { status: "cancel", callerType: "huntgroup", calledType: "phone", calledNumber: "3839595", talkDuration: 0 },
    { status: "answer", callerType: "huntgroup", calledType: "ivr", calledNumber: "73888", talkDuration: 5 },
  ],
};

// Only heard the IVR and hung up — never rang a person at all.
const ivrOnlyInbound = {
  ...operatorMissed,
  callId: "1783385399.845495",
  cdrs: [
    { status: "answer", callerType: "external", calledType: "ivr", calledNumber: "73626", talkDuration: 12 },
  ],
};

// Operator rang, nobody answered, and the system auto-rolled to mailbox 107 with
// a short recording. Still a MISSED call the operator returns — not a voicemail.
const operatorMissedRolledToVoicemail = {
  ...operatorMissed,
  status: "voicemail",
  cdrs: [
    ...operatorMissed.cdrs,
    { status: "answer", callerType: "phone", calledType: "mailbox", calledNumber: "107", talkDuration: 6 },
  ],
};

// Caller chose "leave a message" — the operator (3839601) was never rung — and
// recorded a message on the mailbox → a genuine voicemail.
const pureVoicemail = {
  ...operatorMissed,
  status: "voicemail",
  cdrs: [
    { status: "answer", callerType: "external", calledType: "ivr", calledNumber: "73626", talkDuration: 40 },
    { status: "answer", callerType: "ivr", calledType: "ivr", calledNumber: "73510", talkDuration: 20 },
    { status: "answer", callerType: "ivr", calledType: "mailbox", calledNumber: "107", talkDuration: 18 },
  ],
};

// The operator picked up and talked.
const answeredInbound = {
  ...operatorMissed,
  status: "answered",
  talkDuration: 40,
  cdrs: [
    { status: "answer", callerType: "external", calledType: "ivr", calledNumber: "73626", talkDuration: 60 },
    { status: "answer", callerType: "ivr", calledType: "phone", calledNumber: "3839601", talkDuration: 40 },
  ],
};

const outboundAnswered = {
  callId: "1783300000.1",
  direction: "outgoing",
  status: "answer",
  webhookType: "AccountEndedCalls",
  calledNumber: "16465551234",
  calledName: "Jane Customer",
  callDuration: 55,
  talkDuration: 42,
  cdrs: [
    { status: "answer", callerType: "phone", calledType: "external", calledNumber: "16465551234", talkDuration: 42 },
  ],
};

// A real-time segment webhook (no cdrs). We never import these.
const realTimeRinging = {
  callId: "1783385492.057900",
  direction: "incoming",
  status: "ringing",
  destinationType: "ivr",
  calledNumber: "16467839914",
  callerIdExternal: "19296170150",
};

test("classifyCall reports a missed call only when the operator/main line rang", () => {
  assert.equal(classifyCall(operatorMissed), "missed");
  // Operator rang, no answer, auto-rolled to voicemail → still missed.
  assert.equal(classifyCall(operatorMissedRolledToVoicemail), "missed");
  // Only rang a store, never the operator → ignored.
  assert.equal(classifyCall(storeOnlyMissed), "ignore");
  // Only heard the IVR → ignored.
  assert.equal(classifyCall(ivrOnlyInbound), "ignore");
});

test("classifyCall detects answered, a chosen voicemail, and outbound", () => {
  assert.equal(classifyCall(answeredInbound), "answered");
  // Caller chose to leave a message without the operator being rung.
  assert.equal(classifyCall(pureVoicemail), "voicemail");
  assert.equal(classifyCall(outboundAnswered), "answered");
  assert.equal(isAnsweredCall(answeredInbound), true);
});

test("shouldImportCall imports operator-missed, voicemail, and answered", () => {
  assert.equal(shouldImportCall(operatorMissed), true);
  assert.equal(shouldImportCall(operatorMissedRolledToVoicemail), true);
  assert.equal(shouldImportCall(pureVoicemail), true);
  assert.equal(shouldImportCall(answeredInbound), true);
  assert.equal(shouldImportCall(outboundAnswered), true);
});

test("shouldImportCall skips store-only miss, IVR-only, internal, and real-time", () => {
  assert.equal(shouldImportCall(storeOnlyMissed), false);
  assert.equal(shouldImportCall(ivrOnlyInbound), false);
  assert.equal(shouldImportCall({ ...operatorMissed, direction: "Internal" }), false);
  assert.equal(shouldImportCall(realTimeRinging), false);
});

test("callResultRank ranks answered over voicemail over missed", () => {
  assert.ok(callResultRank("answered") > callResultRank("voicemail"));
  assert.ok(callResultRank("voicemail") > callResultRank("missed"));
  assert.ok(callResultRank("missed") > callResultRank("ignore"));
});

test("extractCustomerPhone reads the external caller (in) and called number (out)", () => {
  assert.equal(extractCustomerPhone(operatorMissed), "18456370687");
  assert.equal(extractCustomerPhone(outboundAnswered), "16465551234");
});

test("buildTelebroadPendingReport labels each outcome and carries the recording", () => {
  const missed = buildTelebroadPendingReport(operatorMissed);
  assert.equal(missed.callResult, "missed");
  assert.equal(missed.details.outcome, "Missed call");
  assert.equal(missed.customerPhoneDigits, "18456370687");
  assert.equal(missed.imported.recordingUrl, "https://api.account.telebroad.com/api/v1/recordings/op.mp3");
  assert.match(missed.title, /missed call/);

  const voicemail = buildTelebroadPendingReport(pureVoicemail);
  assert.equal(voicemail.callResult, "voicemail");
  assert.equal(voicemail.details.outcome, "Voicemail");
});
