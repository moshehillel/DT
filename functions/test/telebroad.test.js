const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTelebroadPendingReport,
  extractCustomerPhone,
  isAnsweredCall,
  shouldImportCall,
} = require("../src/telebroad");

const answeredInbound = {
  callId: "1743731655.796929",
  UniqueId: "1743731665.624991",
  direction: "Incoming",
  status: "ended",
  talkDuration: 33,
  callerIdExternal: "17329942081",
  callerNameExternal: "John Customer",
  callerNameInternal: "Sally Edwards",
  callStartTime: "2025-04-03T21:54:15-04:00",
  startTime: "2025-04-03T21:54:25-04:00",
};

const ringingInbound = {
  ...answeredInbound,
  status: "ringing",
  talkDuration: 0,
};

// Caller rolled to voicemail: the call "ended" but no agent ever talked.
const voicemailInbound = {
  ...answeredInbound,
  status: "voicemail",
  talkDuration: 0,
};

// Rang an agent who never picked up, then hung up: ended with no talk time.
const unansweredInbound = {
  ...answeredInbound,
  talkDuration: 0,
};

const userEndedAnswered = {
  callId: "1743731655.796929",
  direction: "Outgoing",
  status: "answer",
  callerNumber: "1113873",
  calledNumber: "16465551234",
  calledName: "Jane Customer",
  callerName: "Dan Foster",
  talkDuration: 42,
  callDuration: 55,
  webhookType: "UserEndedCalls",
  startTime: "2025-04-03T21:54:15-04:00",
};

test("isAnsweredCall accepts calls a live agent talked on", () => {
  assert.equal(isAnsweredCall(answeredInbound), true);
  assert.equal(isAnsweredCall(ringingInbound), false);
});

test("isAnsweredCall accepts user end call with talk duration", () => {
  assert.equal(isAnsweredCall(userEndedAnswered), true);
  assert.equal(isAnsweredCall({ ...userEndedAnswered, talkDuration: 0 }), false);
});

test("isAnsweredCall rejects voicemail and no-pickup calls", () => {
  assert.equal(isAnsweredCall(voicemailInbound), false);
  assert.equal(isAnsweredCall(unansweredInbound), false);
});

test("shouldImportCall skips internal, voicemail, and unanswered calls", () => {
  assert.equal(shouldImportCall(answeredInbound), true);
  assert.equal(shouldImportCall(ringingInbound), false);
  assert.equal(shouldImportCall(voicemailInbound), false);
  assert.equal(shouldImportCall(unansweredInbound), false);
  assert.equal(shouldImportCall({ ...answeredInbound, direction: "Internal" }), false);
});

test("extractCustomerPhone uses external caller on inbound calls", () => {
  assert.equal(extractCustomerPhone(answeredInbound), "17329942081");
  assert.equal(extractCustomerPhone(userEndedAnswered), "16465551234");
});

test("buildTelebroadPendingReport maps call pending report fields", () => {
  const report = buildTelebroadPendingReport(answeredInbound);

  assert.equal(report.type, "call");
  assert.equal(report.source, "telebroad");
  assert.equal(report.customerPhoneDigits, "17329942081");
  assert.equal(report.details.outcome, "Answered");
  assert.equal(report.details.handledBy, "Sally Edwards");
  assert.equal(report.servedBy, "Sally Edwards");
  assert.match(report.title, /Inbound call/);
});
