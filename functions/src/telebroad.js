const { digitsOnly } = require("./rcuk");

// We classify calls from the "Account end" webhook (webhookType
// "AccountEndedCalls"), which fires once per call and carries the full segment
// history in `cdrs[]`. That history is essential: Telebroad tags BOTH a real
// missed call AND a caller who only heard the IVR as top-level status "missed",
// so status alone is useless. What actually separates them is whether any
// segment rang a real user device (phone/extension), directly or via a
// huntgroup (ring group). The real-time webhook only shows one segment at a
// time and even reports a false "answered" when just the IVR/sipuri picks up,
// so we do not import from it.
const IMPORT_MISSED = true;

// The main service-center / operator line(s). A no-answer becomes a Missed call
// report ONLY when the operator/main line was the one that rang and nobody
// picked up — a call that only rang a store and was abandoned is ignored. The
// operator is reached via the "message or operator" IVR option; it is the phone/
// extension number(s) that option rings (confirmed from a live call: 3839601).
// Leave the set EMPTY to report a no-answer at ANY phone as missed.
const MAIN_LINE_NUMBERS = new Set(["3839601"]);

// Segment (cdr) destination types that mean the call tried to reach a person:
// a phone line, an extension, or a huntgroup/ring group that fans out to them.
const RING_PERSON_TYPES = new Set(["phone", "extension", "huntgroup"]);
// Only a real device actually picking up counts as an agent answering — an IVR
// or "exit greeting" answering a leg does not.
const ANSWER_DEVICE_TYPES = new Set(["phone", "extension"]);
const ANSWERED_LEG_STATUSES = new Set(["answer", "ended"]);

const OUTCOME_LABELS = {
  answered: "Answered",
  voicemail: "Voicemail",
  missed: "Missed call",
};

// If the same call ever produces more than one pending write, keep the "best"
// outcome: answered beats voicemail beats missed.
const CALL_RESULT_RANK = {
  missed: 1,
  voicemail: 2,
  answered: 3,
};

function callResultRank(result) {
  return CALL_RESULT_RANK[result] || 0;
}

function normalizeDirection(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function talkSeconds(leg) {
  return Number(leg && leg.talkDuration) || 0;
}

// The segments of a call. The "Account end" webhook lists them in `cdrs`; if a
// payload has none, treat the payload itself as the single segment.
function callLegs(payload) {
  return Array.isArray(payload.cdrs) && payload.cdrs.length ? payload.cdrs : [payload];
}

function legReachesType(leg, typeSet) {
  return typeSet.has(normalizeStatus(leg.calledType))
    || typeSet.has(normalizeStatus(leg.destinationType));
}

// This is the only webhook we import from — it has the full segment history.
function isEndedCallEvent(payload) {
  return payload.webhookType === "AccountEndedCalls" || Array.isArray(payload.cdrs);
}

// Bucket a call into how it ended: "answered", "voicemail", "missed", or
// "ignore". Driven by the `cdrs` segment history so it handles multi-stage
// flows (ring the store phones, then offer voicemail or an operator, then ring
// the service center) — a no-answer at ANY ring stage, with no message left and
// nobody picking up, is a missed call the operator should return.
function classifyCall(payload) {
  if (!payload || typeof payload !== "object") return "ignore";

  const direction = normalizeDirection(payload.direction);
  const legs = callLegs(payload);

  // Outbound: the far end is the external customer, not a system device — treat
  // it as answered only if there was real talk time.
  if (direction === "outgoing") {
    const talked = legs.some((leg) => talkSeconds(leg) > 0)
      || talkSeconds(payload) > 0;
    return talked ? "answered" : "ignore";
  }

  const answeredByPerson = legs.some(
    (leg) => legReachesType(leg, ANSWER_DEVICE_TYPES)
      && ANSWERED_LEG_STATUSES.has(normalizeStatus(leg.status))
      && talkSeconds(leg) > 0,
  );
  if (answeredByPerson) return "answered";

  // The operator / main line rang but (per the check above) nobody picked up →
  // a missed call to return. This is checked BEFORE voicemail on purpose: the
  // phone system auto-rolls an unanswered operator call to mailbox 107, so it
  // would otherwise look like a voicemail — but the operator still needs to call
  // back. The mailbox recording, if any, stays attached to the missed card. When
  // no main line is configured, any no-answer at a real person counts as missed.
  const rangMainLine = MAIN_LINE_NUMBERS.size
    ? legs.some((leg) => MAIN_LINE_NUMBERS.has(String(leg.calledNumber || "").trim()))
    : legs.some((leg) => legReachesType(leg, RING_PERSON_TYPES));
  if (rangMainLine) return "missed";

  // No operator miss — but a message was left (talk > 0), i.e. the caller chose
  // to leave a voicemail rather than reach the operator. Merely being offered
  // voicemail and hanging up (talk 0) is not a voicemail.
  const leftVoicemail = legs.some(
    (leg) => legReachesType(leg, new Set(["mailbox"])) && talkSeconds(leg) > 0,
  ) || (normalizeStatus(payload.status) === "mailbox" && talkSeconds(payload) > 0);
  if (leftVoicemail) return "voicemail";

  return "ignore";
}

function isAnsweredCall(payload) {
  return classifyCall(payload) === "answered";
}

function callResultLabel(result) {
  return OUTCOME_LABELS[result] || OUTCOME_LABELS.answered;
}

function shouldImportCall(payload) {
  if (!payload || typeof payload !== "object") return false;

  // Only the "Account end" webhook has the segment history we classify from.
  if (!isEndedCallEvent(payload)) return false;

  const direction = normalizeDirection(payload.direction);
  if (direction === "internal") return false;

  const result = classifyCall(payload);
  const importable = result === "answered"
    || result === "voicemail"
    || (result === "missed" && IMPORT_MISSED);
  if (!importable) return false;

  return Boolean(digitsOnly(extractCustomerPhone(payload)));
}

function extractCustomerPhone(payload) {
  const direction = normalizeDirection(payload.direction);

  if (direction === "incoming") {
    return payload.externalCallerId || payload.callerNumber
      || payload.callerIdExternal || payload.sendNumber || "";
  }

  if (direction === "outgoing") {
    return payload.destinationNumber || payload.calledNumber || "";
  }

  return payload.externalCallerId || payload.callerNumber
    || payload.callerIdExternal || payload.destinationNumber || payload.calledNumber || "";
}

function extractCallerName(payload) {
  const direction = normalizeDirection(payload.direction);

  if (direction === "incoming") {
    return payload.externalCallerName || payload.callerName
      || payload.callerNameExternal || payload.sendName || "";
  }

  if (direction === "outgoing") {
    return payload.destinationName || payload.calledName || "";
  }

  return payload.externalCallerName || payload.callerNameExternal || payload.callerName || "";
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
  const result = classifyCall(payload);
  const kind = result === "voicemail"
    ? "voicemail"
    : result === "missed"
      ? "missed call"
      : "call";
  return `${direction} ${kind} ${namePart}(${customerPhone || "unknown"})`;
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
  const callResult = classifyCall(payload);
  const outcomeLabel = callResultLabel(callResult);
  // Answered calls need a full report (claim + complete). Voicemail and missed
  // calls only need to be seen and returned, so they get a lighter note.
  const notes = callResult === "answered"
    ? "Imported from Telebroad. Employee must claim and complete the call report."
    : `Imported from Telebroad (${outcomeLabel}). Call the customer back, then mark it Returned.`;

  return {
    id: sanitizeCallDocId(callId),
    type: "call",
    source: "telebroad",
    status: "pending",
    callResult,
    title: buildPendingCallTitle(payload),
    createdAt,
    servedBy: employeeName,
    customerPhone,
    customerPhoneDigits: digitsOnly(customerPhone),
    paymentAmount: "",
    paymentMethod: "",
    notes,
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
      recordingUrl: payload.recordingUrl || "",
    },
    details: {
      callerName,
      reason: "",
      outcome: outcomeLabel,
      followUpDate: "",
      direction,
      handledBy: employeeName,
      telebroadCallId: callId,
      telebroadUniqueId: payload.UniqueId || "",
      callDuration: payload.callDuration ?? "",
      talkDuration: payload.talkDuration ?? "",
    },
  };
}

// Build the HTTP request for Telebroad's POST /send/sms endpoint. Auth is HTTP
// Basic (account username/password); parameters go in the JSON body.
function buildTelebroadSmsRequest({ baseUrl, username, password, smsLine, to, message }) {
  const url = `${String(baseUrl || "").replace(/\/$/, "")}/send/sms`;
  const credentials = Buffer.from(`${username || ""}:${password || ""}`).toString("base64");
  return {
    url,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        sms_line: smsLine || "",
        receiver: to || "",
        msgdata: message || "",
      }),
    },
  };
}

module.exports = {
  buildPendingCallTitle,
  buildTelebroadPendingReport,
  buildTelebroadSmsRequest,
  callResultRank,
  classifyCall,
  extractCustomerPhone,
  isAnsweredCall,
  sanitizeCallDocId,
  shouldImportCall,
};
