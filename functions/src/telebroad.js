const { digitsOnly } = require("./rcuk");

const ANSWERED_STATUSES = new Set(["ended", "answer"]);

function normalizeDirection(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isAnsweredCall(payload) {
  const webhookType = String(payload.webhookType || "").toLowerCase();
  if (webhookType === "userendedcalls") {
    return Number(payload.talkDuration || 0) > 0;
  }

  return ANSWERED_STATUSES.has(normalizeStatus(payload.status));
}

function shouldImportCall(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!isAnsweredCall(payload)) return false;

  const direction = normalizeDirection(payload.direction);
  if (direction === "internal") return false;

  return Boolean(digitsOnly(extractCustomerPhone(payload)));
}

function extractCustomerPhone(payload) {
  const direction = normalizeDirection(payload.direction);

  if (direction === "incoming") {
    return payload.callerIdExternal || payload.sendNumber || "";
  }

  if (direction === "outgoing") {
    return payload.destinationNumber || payload.calledNumber || "";
  }

  return payload.callerIdExternal || payload.destinationNumber || payload.calledNumber || "";
}

function extractCallerName(payload) {
  const direction = normalizeDirection(payload.direction);

  if (direction === "incoming") {
    return payload.callerNameExternal || payload.sendName || "";
  }

  if (direction === "outgoing") {
    return payload.destinationName || payload.calledName || "";
  }

  return payload.callerNameExternal || payload.callerName || "";
}

function extractEmployeeName(payload) {
  return payload.callerNameInternal
    || payload.callerName
    || payload.sendName
    || payload.destinationName
    || "";
}

function formatDirectionLabel(direction) {
  const normalized = normalizeDirection(direction);
  if (normalized === "incoming") return "Inbound";
  if (normalized === "outgoing") return "Outbound";
  return direction || "Call";
}

function buildPendingCallTitle(payload) {
  const direction = formatDirectionLabel(payload.direction);
  const customerPhone = extractCustomerPhone(payload);
  const callerName = extractCallerName(payload);
  const namePart = callerName ? `${callerName} ` : "";
  return `${direction} call ${namePart}(${customerPhone || "unknown"})`;
}

function sanitizeCallDocId(callId) {
  return `telebroad-${String(callId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function buildTelebroadPendingReport(payload) {
  const customerPhone = extractCustomerPhone(payload);
  const callId = payload.callId || payload.UniqueId || "";
  const createdAt = payload.callStartTime || payload.startTime || new Date().toISOString();
  const direction = normalizeDirection(payload.direction);
  const employeeName = extractEmployeeName(payload);
  const callerName = extractCallerName(payload);

  return {
    id: sanitizeCallDocId(callId),
    type: "call",
    source: "telebroad",
    status: "pending",
    title: buildPendingCallTitle(payload),
    createdAt,
    servedBy: employeeName,
    customerPhone,
    customerPhoneDigits: digitsOnly(customerPhone),
    paymentAmount: "",
    paymentMethod: "",
    notes: "Imported from Telebroad. Employee must claim and complete the call report.",
    imported: {
      callId,
      uniqueId: payload.UniqueId || "",
      direction: payload.direction || "",
      status: payload.status || "",
      webhookType: payload.webhookType || "AccountRealTimeCalls",
      startTime: payload.startTime || "",
      callStartTime: payload.callStartTime || "",
      callDuration: payload.callDuration ?? "",
      talkDuration: payload.talkDuration ?? "",
      employeeName,
      callerNameExternal: payload.callerNameExternal || "",
      callerNameInternal: payload.callerNameInternal || "",
      callerIdExternal: payload.callerIdExternal || "",
      callerIdInternal: payload.callerIdInternal || "",
      destinationNumber: payload.destinationNumber || "",
      destinationName: payload.destinationName || "",
      sendNumber: payload.sendNumber || "",
      sendName: payload.sendName || "",
      sendType: payload.sendType || "",
      destinationType: payload.destinationType || "",
    },
    details: {
      callerName,
      reason: "",
      outcome: "Answered",
      followUpDate: "",
      direction,
      handledBy: employeeName,
      telebroadCallId: callId,
      callDuration: payload.callDuration ?? "",
      talkDuration: payload.talkDuration ?? "",
    },
  };
}

module.exports = {
  buildPendingCallTitle,
  buildTelebroadPendingReport,
  extractCustomerPhone,
  isAnsweredCall,
  sanitizeCallDocId,
  shouldImportCall,
};
