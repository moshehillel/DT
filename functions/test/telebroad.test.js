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
  callerIdExternal: "17329942081",
  callerNameExternal: "John Customer",
  callerNameInternal: "Sally Edwards",
  callStartTime: "2025-04-03T21:54:15-04:00",
  startTime: "2025-04-03T21:54:25-04:00",
};

const ringingInbound = {
  ...answeredInbound,
  status: "ringing",
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

test("isAnsweredCall accepts ended account real-time calls", () => {
  assert.equal(isAnsweredCall(answeredInbound), true);
  assert.equal(isAnsweredCall(ringingInbound), false);
});

test("isAnsweredCall accepts user end call with talk duration", () => {
  assert.equal(isAnsweredCall(userEndedAnswered), true);
  assert.equal(isAnsweredCall({ ...userEndedAnswered, talkDuration: 0 }), false);
});

test("shouldImportCall skips internal and unanswered calls", () => {
  assert.equal(shouldImportCall(answeredInbound), true);
  assert.equal(shouldImportCall(ringingInbound), false);
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
