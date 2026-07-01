const crypto = require("node:crypto");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const twilio = require("twilio");
const {
  buildRcukRentalPayload,
  digitsOnly,
  normalizeRcukSimNumber,
} = require("./rcuk");
const { buildRepairMessage, buildRepairReceivedMessage, findRepairByLookup } = require("./repairs");
const {
  buildTelebroadPendingReport,
  buildTelebroadSmsRequest,
  shouldImportCall,
} = require("./telebroad");
const { extractShopifyImei } = require("./shopify");
const {
  buildResultLookup,
  buildSaleSession,
  formatAmount,
  interpretResult,
} = require("./solaDevice");

admin.initializeApp();

const db = admin.firestore();
const REGION = "us-central1";
const HTTP_OPTIONS = { region: REGION };
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_REQUEST_TOKEN = process.env.TWILIO_REQUEST_TOKEN || "";
const TELEBROAD_API_BASE_URL = process.env.TELEBROAD_API_BASE_URL || "https://webserv.telebroad.com/api/teleconsole/rest";
const TELEBROAD_USERNAME = process.env.TELEBROAD_USERNAME || "";
const TELEBROAD_PASSWORD = process.env.TELEBROAD_PASSWORD || "";
const TELEBROAD_SMS_LINE = process.env.TELEBROAD_SMS_LINE || "13473887467";
const RCUK_API_KEY = process.env.RCUK_API_KEY || "";
const RCUK_API_BASE_URL = process.env.RCUK_API_BASE_URL || "https://myaccount.rcuk.com/api";
const RCUK_ADD_RENTAL_PATH = process.env.RCUK_ADD_RENTAL_PATH || "/add-rental";
const RCUK_GET_RENTAL_PATH = process.env.RCUK_GET_RENTAL_PATH || "/get-rental";
const RCUK_CHECK_SIM_PATH = process.env.RCUK_CHECK_SIM_PATH || "/check-sim";
const RCUK_CANCEL_RENTAL_PATH = process.env.RCUK_CANCEL_RENTAL_PATH || "/cancel-rental";
const SOLA_API_KEY = process.env.SOLA_API_KEY || "";
const SOLA_API_BASE_URL = process.env.SOLA_API_BASE_URL || "https://x1.cardknox.com";
const SOLA_CREATE_CHARGE_PATH = process.env.SOLA_CREATE_CHARGE_PATH || "/gatewayjson";
// CloudIM cloud endpoint for card-present terminal payments (PAX A80, etc.).
const SOLA_DEVICE_API_BASE_URL = process.env.SOLA_DEVICE_API_BASE_URL || "https://device.cardknox.com/v2";
const RENTAL_REMINDER_TIME_ZONE = process.env.RENTAL_REMINDER_TIME_ZONE || "America/New_York";
const MAPS_API_KEY = process.env.MAPS_API_KEY || "";

function getPayload(req) {
  return {
    ...(req.query || {}),
    ...(typeof req.body === "object" && req.body ? req.body : {}),
  };
}

// ---- Employee account management (admin-only callable functions) ----

function assertAdmin(request) {
  if (!request.auth || request.auth.token.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access is required.");
  }
}

exports.listEmployees = onCall({ region: REGION }, async (request) => {
  assertAdmin(request);
  const result = await admin.auth().listUsers(1000);
  return result.users.map((user) => ({
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || "",
    disabled: user.disabled,
    admin: user.customClaims?.role === "admin",
  }));
});

exports.createEmployee = onCall({ region: REGION }, async (request) => {
  assertAdmin(request);
  const { email, password, displayName, isAdmin } = request.data || {};
  if (!email || !password) {
    throw new HttpsError("invalid-argument", "Email and password are required.");
  }
  if (String(password).length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  }
  let user;
  try {
    user = await admin.auth().createUser({
      email: String(email).trim(),
      password: String(password),
      displayName: String(displayName || "").trim() || undefined,
    });
  } catch (error) {
    throw new HttpsError("already-exists", error.message || "Could not create the user.");
  }
  if (isAdmin) {
    await admin.auth().setCustomUserClaims(user.uid, { role: "admin" });
  }
  return {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || "",
    admin: Boolean(isAdmin),
  };
});

exports.setEmployeeAdmin = onCall({ region: REGION }, async (request) => {
  assertAdmin(request);
  const { uid, isAdmin } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");
  if (uid === request.auth.uid && !isAdmin) {
    throw new HttpsError("failed-precondition", "You cannot remove your own admin access.");
  }
  await admin.auth().setCustomUserClaims(uid, isAdmin ? { role: "admin" } : {});
  return { uid, admin: Boolean(isAdmin) };
});

exports.deleteEmployee = onCall({ region: REGION }, async (request) => {
  assertAdmin(request);
  const { uid } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");
  if (uid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "You cannot delete your own account.");
  }
  await admin.auth().deleteUser(uid);
  return { uid, deleted: true };
});

// ---- Address autocomplete (Google Places, proxied so the key stays server-side) ----

// Returns address suggestions for what the user has typed. Any signed-in user
// may call it. `sessionToken` ties the autocomplete calls to the follow-up
// placeDetails call for Google's per-session billing.
exports.placesAutocomplete = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!MAPS_API_KEY) throw new HttpsError("failed-precondition", "MAPS_API_KEY is not configured.");
  const input = String(request.data?.input || "").trim();
  if (input.length < 3) return { suggestions: [] };
  const sessionToken = String(request.data?.sessionToken || "") || undefined;

  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_API_KEY },
    body: JSON.stringify({ input, sessionToken, includedRegionCodes: ["us"] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpsError("internal", data?.error?.message || "Places autocomplete failed.");
  }
  const suggestions = (data.suggestions || [])
    .map((item) => item.placePrediction)
    .filter(Boolean)
    .map((prediction) => ({ placeId: prediction.placeId, description: prediction.text?.text || "" }))
    .filter((item) => item.placeId && item.description);
  return { suggestions };
});

// Resolves a selected suggestion into structured address parts.
exports.placeDetails = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (!MAPS_API_KEY) throw new HttpsError("failed-precondition", "MAPS_API_KEY is not configured.");
  const placeId = String(request.data?.placeId || "").trim();
  if (!placeId) throw new HttpsError("invalid-argument", "placeId is required.");
  const sessionToken = String(request.data?.sessionToken || "");

  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  const response = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": MAPS_API_KEY,
      "X-Goog-FieldMask": "formattedAddress,addressComponents",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpsError("internal", data?.error?.message || "Place details failed.");
  }
  const components = data.addressComponents || [];
  const pick = (type) => components.find((component) => (component.types || []).includes(type));
  const streetNumber = pick("street_number")?.longText || "";
  const route = pick("route")?.longText || "";
  const city =
    pick("locality")?.longText ||
    pick("postal_town")?.longText ||
    pick("sublocality")?.longText ||
    "";
  const state = pick("administrative_area_level_1")?.shortText || "";
  const zip = pick("postal_code")?.longText || "";
  return {
    street: `${streetNumber} ${route}`.trim(),
    city,
    state,
    zip,
    formatted: data.formattedAddress || "",
  };
});

function sendJson(res, status, body) {
  res.status(status).set("Content-Type", "application/json").send(body);
}

// Fetches a Telebroad call recording (by callid + uniqueid from the webhook) and
// serves it. Opening this URL in the browser plays/downloads the recording; the
// account credentials stay server-side.
exports.telebroadCallRecording = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;

  const payload = getPayload(req);
  const callid = String(payload.callid || payload.callId || "").trim();
  const uniqueid = String(payload.uniqueid || payload.uniqueId || payload.UniqueId || "").trim();
  if (!callid || !uniqueid) {
    sendJson(res, 400, { ok: false, message: "callid and uniqueid are required." });
    return;
  }
  if (!TELEBROAD_USERNAME || !TELEBROAD_PASSWORD) {
    sendJson(res, 501, { ok: false, message: "Telebroad credentials are not configured." });
    return;
  }

  try {
    const credentials = Buffer.from(`${TELEBROAD_USERNAME}:${TELEBROAD_PASSWORD}`).toString("base64");
    const url = `${TELEBROAD_API_BASE_URL}/call/recording?callid=${encodeURIComponent(callid)}&uniqueid=${encodeURIComponent(uniqueid)}`;
    const tbResponse = await fetch(url, { headers: { Authorization: `Basic ${credentials}` } });
    const contentType = tbResponse.headers.get("content-type") || "";

    // JSON response: either an error, or a link to the recording.
    if (contentType.includes("application/json")) {
      const data = await tbResponse.json().catch(() => ({}));
      if (data.error) {
        sendJson(res, 400, { ok: false, message: data.error.message || "Recording not available." });
        return;
      }
      const recordingUrl = data.url || data.recording || data.recordingUrl || data.link || data.path || "";
      if (recordingUrl) {
        if (payload.json === "1") {
          sendJson(res, 200, { ok: true, url: recordingUrl });
        } else {
          res.redirect(recordingUrl);
        }
        return;
      }
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    // Otherwise the body is the audio itself — stream it back.
    if (!tbResponse.ok) {
      sendJson(res, 400, { ok: false, message: `Telebroad returned ${tbResponse.status}.` });
      return;
    }
    const audio = Buffer.from(await tbResponse.arrayBuffer());
    res.set("Content-Type", contentType || "audio/mpeg");
    res.set("Content-Disposition", `inline; filename="recording-${callid}.mp3"`);
    res.status(200).send(audio);
  } catch (error) {
    logger.error("telebroadCallRecording failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Could not get the recording." });
  }
});

function handleCors(req, res) {
  res.set("Access-Control-Allow-Origin", process.env.ALLOWED_WEB_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

async function callRcuk(path, payload, method = "POST") {
  if (!RCUK_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: {
        code: 500,
        message: "RCUK_API_KEY is not configured on the backend.",
      },
    };
  }

  const isGet = method.toUpperCase() === "GET";
  let url = `${RCUK_API_BASE_URL}${path}`;

  if (isGet && payload && Object.keys(payload).length) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && value !== "") {
        params.append(key, String(value));
      }
    }
    const query = params.toString();
    if (query) url += `?${query}`;
  }

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "api-key": RCUK_API_KEY,
    },
    ...(isGet ? {} : { body: JSON.stringify(payload) }),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      code: response.status,
      message: text || "RCUK returned a non-JSON response.",
    };
  }

  return {
    ok: response.ok && Number(data.code || response.status) >= 200 && Number(data.code || response.status) < 300,
    status: response.status,
    data,
  };
}

function validateTwilioSignature(req) {
  const payload = getPayload(req);

  if (TWILIO_REQUEST_TOKEN) {
    return payload.authToken === TWILIO_REQUEST_TOKEN;
  }

  if (!TWILIO_AUTH_TOKEN || !req.header("X-Twilio-Signature")) return true;

  const signature = req.header("X-Twilio-Signature");
  const protocol = req.header("X-Forwarded-Proto") || req.protocol || "https";
  const host = req.header("X-Forwarded-Host") || req.header("Host");
  const url = `${protocol}://${host}${req.originalUrl || req.url}`;

  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, payload);
}

function assertTwilioRequest(req, res) {
  if (validateTwilioSignature(req)) return true;
  sendJson(res, 403, { error: "Invalid Twilio signature" });
  return false;
}

exports.repairStatus = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  if (!assertTwilioRequest(req, res)) return;

  try {
    const payload = getPayload(req);
    const lookup =
      payload.ticketLookup || payload.phone || payload.lookup || payload.Digits || payload.caller || "";
    const repair = await findRepairByLookup(db, lookup);

    if (!repair) {
      sendJson(res, 200, {
        found: false,
        ticketNumber: "",
        model: "",
        status: "",
        customerMessage: "No repair was found for that lookup.",
      });
      return;
    }

    sendJson(res, 200, {
      found: true,
      ticketNumber: repair.details.ticketNumber || "unknown",
      model: repair.details.model || "your device",
      status: repair.details.status || "Received",
      customerMessage: buildRepairMessage(repair),
    });
  } catch (error) {
    logger.error("repairStatus failed", error);
    sendJson(res, 500, { error: "Repair lookup failed" });
  }
});

function phoneDetailText(phone) {
  const parts = [
    phone.model,
    phone.storage,
    phone.color,
    phone.carrier ? `${phone.carrier} carrier` : "",
    phone.condition,
    phone.batteryHealth ? `battery health ${phone.batteryHealth}` : "",
    phone.price ? `price ${phone.price} dollars` : "",
    phone.notes,
  ].filter(Boolean);

  return parts.join(", ");
}

async function getAvailablePhones() {
  const snapshot = await db
    .collection("inventoryPhones")
    .where("status", "==", "available")
    .orderBy("listOrder", "asc")
    .limit(9)
    .get();

  return snapshot.docs.map((doc, index) => ({
    id: doc.id,
    choice: index + 1,
    ...doc.data(),
  }));
}

exports.phoneInventoryList = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  if (!assertTwilioRequest(req, res)) return;

  try {
    const phones = await getAvailablePhones();

    if (!phones.length) {
      sendJson(res, 200, {
        available: false,
        menuText: "",
      });
      return;
    }

    const menuText = phones
      .map((phone) => `Press ${phone.choice} for ${phone.model || "phone"}, ${phone.price || "price not listed"} dollars.`)
      .join(" ");

    sendJson(res, 200, {
      available: true,
      count: phones.length,
      menuText,
    });
  } catch (error) {
    logger.error("phoneInventoryList failed", error);
    sendJson(res, 500, { error: "Phone inventory lookup failed" });
  }
});

exports.phoneInventoryDetails = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  if (!assertTwilioRequest(req, res)) return;

  try {
    const payload = getPayload(req);
    const choice = Number.parseInt(payload.choice || payload.Digits || "", 10);
    const phones = await getAvailablePhones();
    const phone = phones.find((item) => item.choice === choice);

    if (!phone) {
      sendJson(res, 200, {
        found: false,
        detailText: "That phone option was not found.",
      });
      return;
    }

    sendJson(res, 200, {
      found: true,
      phoneId: phone.id,
      detailText: phoneDetailText(phone),
    });
  } catch (error) {
    logger.error("phoneInventoryDetails failed", error);
    sendJson(res, 500, { error: "Phone detail lookup failed" });
  }
});

function getTwilioClient() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) return null;
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Outgoing voice calls (e.g. rental return reminders) stay on Twilio.
async function sendVoiceCall({ to, body }) {
  const client = getTwilioClient();
  if (!client) {
    return { status: "Queued", detail: "Twilio credentials are not configured" };
  }

  const call = await client.calls.create({
    to,
    from: TWILIO_FROM_NUMBER,
    twiml: `<Response><Say>${escapeXml(body)}</Say></Response>`,
  });
  return { status: "Sent", detail: `Call ${call.sid}` };
}

// Telebroad expects a US number with country code. Customer numbers already
// carry a leading "1" (the phone field pre-fills it), but handler numbers are
// usually entered as bare 10 digits — add the "1" so both send the same way.
function normalizeSmsRecipient(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

// Outgoing SMS goes through the Telebroad REST API.
async function sendSms({ to, body }) {
  if (!TELEBROAD_USERNAME || !TELEBROAD_PASSWORD || !TELEBROAD_SMS_LINE) {
    return { status: "Queued", detail: "Telebroad SMS credentials are not configured" };
  }

  const receiver = normalizeSmsRecipient(to);
  if (!receiver) {
    return { status: "Failed", detail: "Telebroad SMS: no valid recipient number" };
  }

  const { url, options } = buildTelebroadSmsRequest({
    baseUrl: TELEBROAD_API_BASE_URL,
    username: TELEBROAD_USERNAME,
    password: TELEBROAD_PASSWORD,
    smsLine: TELEBROAD_SMS_LINE,
    to: receiver,
    message: body,
  });

  // Guard the call with a timeout so a slow/unreachable Telebroad response can
  // never hang the whole function until its 60s kill (which would drop CORS
  // headers and fail the browser request). 15s is plenty for an SMS POST.
  let response;
  let text;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    text = await response.text();
  } catch (error) {
    const reason = error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "request timed out"
      : (error && error.message) || "network error";
    return { status: "Failed", detail: `Telebroad SMS: ${reason}` };
  }

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  // Telebroad returns HTTP 200 even on failure; the error lives in data.error.
  if (!response.ok || data.error) {
    const detail = data.error
      ? `${data.error.code || ""} ${data.error.message || ""}`.trim()
      : `HTTP ${response.status}`;
    return { status: "Failed", detail: `Telebroad SMS: ${detail || "unknown error"}` };
  }

  return { status: "Sent", detail: `Telebroad SMS ${data.result ?? ""}`.trim() };
}

async function sendCustomerNotification({ to, method, body }) {
  if (method === "Both") {
    const [sms, call] = await Promise.all([
      sendSms({ to, body }),
      sendVoiceCall({ to, body }),
    ]);
    const status = sms.status === "Sent" || call.status === "Sent" ? "Sent" : "Failed";
    return {
      status,
      detail: `Text: ${sms.detail || sms.status}; Call: ${call.detail || call.status}`,
    };
  }
  if (method === "Phone call") {
    return sendVoiceCall({ to, body });
  }
  return sendSms({ to, body });
}

async function logNotification(reportId, report, status, detail) {
  await db.collection("notificationLogs").add({
    reportId,
    servedByEmployeeId: report.servedByEmployeeId || "",
    customerPhone: report.customerPhone || "",
    method: report.details?.notificationPreference || "Text message",
    status,
    detail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function writeNotificationLog(logId, reportId, report, method, status, detail, type) {
  await db.collection("notificationLogs").doc(logId).set({
    reportId,
    type,
    servedByEmployeeId: report.servedByEmployeeId || "",
    customerPhone: report.customerPhone || "",
    method,
    status,
    detail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Text the customer their ticket + details the moment a repair is accepted in store.
exports.notifyRepairReceived = onDocumentCreated(
  {
    region: REGION,
    document: "reports/{reportId}",
  },
  async (event) => {
    const report = event.data?.data();
    if (!report || report.type !== "repair") return;
    // Only a genuinely received repair has a ticket; drafts/other statuses are skipped.
    if (report.details?.status !== "Received" || !report.details?.ticketNumber) return;

    const to = report.customerPhone;
    if (!to) {
      await logNotification(event.params.reportId, report, "Skipped", "No customer phone number");
      return;
    }

    const body = buildRepairReceivedMessage(report);
    try {
      const result = await sendSms({ to, body });
      // Only log failures; a successful text needs no record.
      if (result.status !== "Sent") {
        await logNotification(event.params.reportId, report, result.status, result.detail);
      }
    } catch (error) {
      logger.error("notifyRepairReceived failed", error);
      await logNotification(event.params.reportId, report, "Failed", error.message);
    }
  },
);

exports.notifyRepairDelivered = onDocumentUpdated(
  {
    region: REGION,
    document: "reports/{reportId}",
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after || after.type !== "repair") return;

    // Fire on two independent transitions: status -> Ready, and payment -> Paid.
    const becameReady = before.details?.status !== "Ready" && after.details?.status === "Ready";
    const becamePaid = before.details?.paymentStatus !== "Paid" && after.details?.paymentStatus === "Paid";
    if (!becameReady && !becamePaid) return;

    const to = after.customerPhone;
    if (!to) {
      await logNotification(event.params.reportId, after, "Skipped", "No customer phone number");
      return;
    }

    const sendOne = async (method, body) => {
      try {
        const result = await sendCustomerNotification({ to, method, body });
        // Only log failures; a successful text needs no record.
        if (result.status !== "Sent") {
          await logNotification(event.params.reportId, after, result.status, result.detail);
        }
      } catch (error) {
        logger.error("notifyRepairDelivered failed", error);
        await logNotification(event.params.reportId, after, "Failed", error.message);
      }
    };

    if (becameReady) {
      const amountDue = after.details?.finalPrice || after.paymentAmount || "";
      const dueText =
        amountDue && after.details?.paymentStatus !== "Paid"
          ? ` Amount due: $${(Number(amountDue) || 0).toFixed(2)}.`
          : "";
      const body = `Diamant Telecom: repair ticket ${after.details?.ticketNumber || ""} for ${after.details?.model || "your phone"} is ready for pickup.${dueText}`;
      await sendOne(after.details?.notificationPreference || "Text message", body);
    }

    if (becamePaid) {
      const ticket = after.details?.ticketNumber ? ` ticket ${after.details.ticketNumber}` : "";
      const model = after.details?.model || "your phone";
      await sendOne("Text message", `Diamant Telecom: payment for your ${model} repair${ticket} is marked paid. Thank you!`);
    }
  },
);

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

exports.shopifyOrderWebhook = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  const hmac = req.header("X-Shopify-Hmac-Sha256") || "";
  const rawBody = req.rawBody;

  if (secret && rawBody) {
    const digest = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");

    const digestBuffer = Buffer.from(digest);
    const hmacBuffer = Buffer.from(hmac, "base64");
    if (
      digestBuffer.length !== hmacBuffer.length
      || !crypto.timingSafeEqual(digestBuffer, hmacBuffer)
    ) {
      sendJson(res, 403, { error: "Invalid Shopify signature" });
      return;
    }
  }

  const order = req.body || {};
  const pendingReportId = `shopify-${order.id}`;
  const lineItems = order.line_items || [];
  const lineItemsText = lineItems
    .map((item) => `${item.quantity || 1}x ${item.title || item.name || "Item"}`)
    .join(", ");
  const imei = extractShopifyImei(order);

  await db.collection("pendingReports").doc(pendingReportId).set(
    {
      type: "sale",
      source: "shopify_pos",
      status: "pending",
      shopifyOrderId: String(order.id || ""),
      shopifyOrderName: order.name || "",
      createdAt: order.created_at || new Date().toISOString(),
      customerPhone: order.customer?.phone || order.phone || "",
      customerPhoneDigits: digitsOnly(order.customer?.phone || order.phone || ""),
      paymentAmount: order.total_price || "",
      // Payment is collected in-store (cash or Sola terminal); the employee
      // records the real method when completing the report.
      paymentMethod: "",
      notes: "Imported from Shopify. Employee must complete missing fields and record payment.",
      imported: {
        shopifyOrderId: String(order.id || ""),
        shopifyOrderName: order.name || "",
        totalPrice: order.total_price || "",
        subtotalPrice: order.subtotal_price || "",
        totalTax: order.total_tax || "",
        currency: order.currency || "",
        customerPhone: order.customer?.phone || order.phone || "",
        customerEmail: order.customer?.email || order.email || "",
        customerName: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" "),
        locationName: order.location?.name || "",
        locationId: order.location_id ? String(order.location_id) : "",
        lineItems,
        lineItemsText,
        imei,
        paymentGatewayNames: order.payment_gateway_names || [],
        financialStatus: order.financial_status || "",
        fulfillmentStatus: order.fulfillment_status || "",
      },
      details: {
        request: "Shopify POS sale",
        productType: "Phone",
        model: lineItemsText,
        imei,
        lineItems,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  sendJson(res, 200, { ok: true });
});

exports.telebroadCallWebhook = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const payload = getPayload(req);

    if (!shouldImportCall(payload)) {
      sendJson(res, 200, {
        ok: true,
        imported: false,
        reason: "ignored",
      });
      return;
    }

    const pendingReport = buildTelebroadPendingReport(payload);
    const pendingRef = db.collection("pendingReports").doc(pendingReport.id);
    const existing = await pendingRef.get();

    if (existing.exists) {
      sendJson(res, 200, {
        ok: true,
        imported: false,
        reason: "already_imported",
        pendingReportId: pendingReport.id,
      });
      return;
    }

    await pendingRef.set({
      ...pendingReport,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJson(res, 200, {
      ok: true,
      imported: true,
      pendingReportId: pendingReport.id,
    });
  } catch (error) {
    logger.error("telebroadCallWebhook failed", error);
    sendJson(res, 500, { error: "Telebroad call import failed" });
  }
});

function extractRentalId(data) {
  return data.rental_id
    || data.rentalId
    || data.reactivated_rental_id
    || data.id
    || data.ID
    || data.data?.rental_id
    || data.data?.rentalId
    || data.data?.ID
    || data.rental_data?.rental_id
    || data.rental_data?.id
    || data.rental_data?.ID
    || "";
}

function normalizeRentalLookup(data) {
  const rentalData = data.rental_data || data.data || data;
  const cli = rentalData.cli || rentalData.CLI || rentalData.phone_number || "";
  const usDdi = rentalData.us_ddi || rentalData.usDDI || rentalData.usa_number || rentalData.us_number || "";
  const ilDdi = rentalData.il_ddi || rentalData.ilDDI || rentalData.israel_number || "";
  const status = rentalData.status || rentalData.Status || "";

  return {
    rentalId: extractRentalId(data),
    cli,
    usDdi,
    ilDdi,
    status,
    pending: !cli && !usDdi,
    raw: data,
  };
}

exports.rcukAddRental = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const payload = getPayload(req);
    const rcukPayload = buildRcukRentalPayload(payload);

    if (!rcukPayload.sim_number) {
      sendJson(res, 400, {
        ok: false,
        message: "sim_number is required.",
      });
      return;
    }

    const result = await callRcuk(RCUK_ADD_RENTAL_PATH, rcukPayload);
    const rentalId = extractRentalId(result.data);

    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        message: result.data.message || "RCUK add rental failed.",
        raw: result.data,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      rentalId,
      message: result.data.message || "Rental submitted.",
      raw: result.data,
    });
  } catch (error) {
    logger.error("rcukAddRental failed", error);
    sendJson(res, 500, {
      ok: false,
      message: error.message || "RCUK add rental failed.",
    });
  }
});

exports.rcukCheckSim = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const payload = getPayload(req);
    const simNumber = normalizeRcukSimNumber(payload.sim_number || payload.simNumber);

    if (!simNumber) {
      sendJson(res, 400, {
        ok: false,
        message: "sim_number is required.",
      });
      return;
    }

    const result = await callRcuk(RCUK_CHECK_SIM_PATH, { sim_number: simNumber });

    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        simNumber,
        message: result.data.message || "RCUK check SIM failed.",
        raw: result.data,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      simNumber,
      message: result.data.message || "SIM check complete.",
      raw: result.data,
    });
  } catch (error) {
    logger.error("rcukCheckSim failed", error);
    sendJson(res, 500, {
      ok: false,
      message: error.message || "RCUK check SIM failed.",
    });
  }
});

exports.rcukGetRental = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const payload = getPayload(req);
    const rentalId = payload.rental_id || payload.rentalId || payload.id;

    if (!rentalId) {
      sendJson(res, 400, {
        ok: false,
        message: "rental_id is required.",
      });
      return;
    }

    const result = await callRcuk(RCUK_GET_RENTAL_PATH, { rental_id: rentalId }, "GET");
    const normalized = normalizeRentalLookup(result.data);

    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        message: result.data.message || "RCUK get rental failed.",
        ...normalized,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      message: result.data.message || "Rental lookup complete.",
      ...normalized,
    });
  } catch (error) {
    logger.error("rcukGetRental failed", error);
    sendJson(res, 500, {
      ok: false,
      message: error.message || "RCUK get rental failed.",
    });
  }
});

exports.rcukCancelRental = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const payload = getPayload(req);
    const rentalId = payload.rental_id || payload.rentalId || payload.id;

    if (!rentalId) {
      sendJson(res, 400, { ok: false, message: "rental_id is required." });
      return;
    }

    // RCUK requires a reason, and the day allocations for active rentals. Default
    // to "immediate" so the SIM is freed right away.
    const cancelPayload = {
      rental_id: rentalId,
      reason: String(payload.reason || "Cancelled in store").slice(0, 255),
      cancel_type: payload.cancel_type || "immediate",
      uk_days: Number(payload.uk_days) || 0,
      eu_days: Number(payload.eu_days) || 0,
      wts_days: Number(payload.wts_days) || 0,
      tp_days: Number(payload.tp_days) || 0,
    };

    const result = await callRcuk(RCUK_CANCEL_RENTAL_PATH, cancelPayload);

    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        message: result.data.message || "RCUK cancel rental failed.",
        raw: result.data,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      message: result.data.message || "Rental cancelled.",
      raw: result.data,
    });
  } catch (error) {
    logger.error("rcukCancelRental failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "RCUK cancel rental failed." });
  }
});

function normalizeSolaCharge(data) {
  const charge = data.charge || data.payment || data.data || data;
  return {
    transactionId: charge.xRefNum
      || charge.xRefnum
      || charge.xAuthCode
      || charge.transactionId
      || charge.transaction_id
      || charge.payment_id
      || charge.paymentId
      || charge.id
      || "",
    paymentUrl: charge.payment_url
      || charge.paymentUrl
      || charge.checkout_url
      || charge.checkoutUrl
      || charge.url
      || "",
    status: charge.xStatus || charge.status || data.status || "",
    raw: data,
  };
}

exports.solaCreateCharge = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  const payload = getPayload(req);
  const amount = Number.parseFloat(payload.amount || "0");
  const paymentToken = payload.paymentToken || payload.solaToken || payload.sut || payload.xToken || "";

  if (!Number.isFinite(amount) || amount <= 0) {
    sendJson(res, 400, {
      ok: false,
      message: "A valid amount is required.",
    });
    return;
  }

  if (!paymentToken) {
    sendJson(res, 400, {
      ok: false,
      message: "A Sola hosted-card token or SUT is required.",
    });
    return;
  }

  if (!SOLA_API_KEY) {
    sendJson(res, 501, {
      ok: false,
      message: "Sola is not configured yet. Set SOLA_API_KEY on Firebase Functions.",
    });
    return;
  }

  try {
    const solaPayload = {
      xKey: SOLA_API_KEY,
      xVersion: "5.0.0",
      xSoftwareName: "Diamant Telecom Reports",
      xSoftwareVersion: "0.1.0",
      xCommand: "cc:sale",
      xAmount: amount.toFixed(2),
      xToken: paymentToken,
      xCurrency: payload.currency || "USD",
      xDescription: payload.description || "Diamant Telecom rental",
      xCustom01: payload.rentalId || "",
      xBillPhone: payload.customerPhone || "",
    };

    const response = await fetch(`${SOLA_API_BASE_URL}${SOLA_CREATE_CHARGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(solaPayload),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        message: text || "Sola returned a non-JSON response.",
      };
    }
    const normalized = normalizeSolaCharge(data);
    const approved = String(data.xResult || data.xStatus || data.status || "").toLowerCase() === "approved"
      || String(data.xStatus || data.status || "").toLowerCase() === "success";

    if (!response.ok || !approved) {
      sendJson(res, 400, {
        ok: false,
        message: data.xError || data.xErrorCode || data.message || "Sola charge failed.",
        ...normalized,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      message: data.xResult || data.message || "Sola charge approved.",
      ...normalized,
      status: "approved",
    });
  } catch (error) {
    logger.error("solaCreateCharge failed", error);
    sendJson(res, 500, {
      ok: false,
      message: error.message || "Sola charge failed.",
    });
  }
});

// Refund a previous Sola card sale by reference (the xRefNum returned when the
// sale was charged). Uses the gateway cc:refund command, so no terminal is
// needed to send the money back to the original card.
exports.solaRefund = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  const payload = getPayload(req);
  const amount = Number.parseFloat(payload.amount || "0");
  const refNum = payload.refNum || payload.xRefNum || payload.refnum || "";

  if (!Number.isFinite(amount) || amount <= 0) {
    sendJson(res, 400, { ok: false, message: "A valid refund amount is required." });
    return;
  }
  if (!refNum) {
    sendJson(res, 400, { ok: false, message: "The original transaction reference (refNum) is required." });
    return;
  }
  if (!SOLA_API_KEY) {
    sendJson(res, 501, {
      ok: false,
      message: "Sola is not configured yet. Set SOLA_API_KEY on Firebase Functions.",
    });
    return;
  }

  try {
    const solaPayload = {
      xKey: SOLA_API_KEY,
      xVersion: "5.0.0",
      xSoftwareName: "Diamant Telecom Reports",
      xSoftwareVersion: "0.1.0",
      xCommand: "cc:refund",
      xAmount: amount.toFixed(2),
      xRefNum: refNum,
    };

    const response = await fetch(`${SOLA_API_BASE_URL}${SOLA_CREATE_CHARGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(solaPayload),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text || "Sola returned a non-JSON response." };
    }
    const normalized = normalizeSolaCharge(data);
    const approved = String(data.xResult || data.xStatus || data.status || "").toLowerCase() === "approved"
      || String(data.xStatus || data.status || "").toLowerCase() === "success";

    if (!response.ok || !approved) {
      sendJson(res, 400, {
        ok: false,
        message: data.xError || data.xErrorCode || data.message || "Sola refund failed.",
        ...normalized,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      message: data.xResult || data.message || "Sola refund approved.",
      ...normalized,
      status: "refunded",
    });
  } catch (error) {
    logger.error("solaRefund failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Sola refund failed." });
  }
});

async function callSolaDevice(path, body) {
  const response = await fetch(`${SOLA_DEVICE_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: SOLA_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { xError: text || "Sola device returned a non-JSON response." };
  }
  return { ok: response.ok, status: response.status, data };
}

// Sola CloudIM: start a card-present sale on a terminal (PAX A80, etc.). The
// terminal prompts the customer to tap/dip/swipe; we return a session id the
// POS polls with solaDeviceResult.
exports.solaDeviceSale = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "POST required" });
    return;
  }
  if (!SOLA_API_KEY) {
    sendJson(res, 501, {
      ok: false,
      message: "Sola is not configured yet. Set SOLA_API_KEY on Firebase Functions.",
    });
    return;
  }

  const payload = getPayload(req);
  const amount = formatAmount(payload.amount);
  const deviceId = payload.deviceId;

  if (!amount) {
    sendJson(res, 400, { ok: false, message: "A valid amount is required." });
    return;
  }
  if (!deviceId) {
    sendJson(res, 400, { ok: false, message: "A terminal deviceId is required. Set this store's Sola device ID in Inventory → Stores." });
    return;
  }

  try {
    const session = buildSaleSession({
      apiKey: SOLA_API_KEY,
      deviceId,
      amount,
      externalRequestId: payload.externalRequestId || `pos-${Date.now()}`,
      tip: payload.tip,
      enableTipPrompt: payload.enableTipPrompt,
      manualEntry: payload.manualEntry === true || payload.manualEntry === "true",
    });
    const result = await callSolaDevice("/session/async", session);
    const interpreted = interpretResult(result.data);

    if (!result.ok || interpreted.error) {
      sendJson(res, 400, {
        ok: false,
        message: result.data.xError || result.data.message || "Sola could not start the terminal sale.",
        raw: result.data,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      sessionId: result.data.xSessionId || "",
      externalRequestId: session.xExternalRequestId,
      status: interpreted.status,
      raw: result.data,
    });
  } catch (error) {
    logger.error("solaDeviceSale failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Sola terminal sale failed." });
  }
});

// Sola CloudIM: poll the result of a terminal sale by session id.
exports.solaDeviceResult = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "POST required" });
    return;
  }
  if (!SOLA_API_KEY) {
    sendJson(res, 501, {
      ok: false,
      message: "Sola is not configured yet. Set SOLA_API_KEY on Firebase Functions.",
    });
    return;
  }

  const payload = getPayload(req);
  const sessionId = payload.sessionId || payload.xSessionId || "";
  const externalRequestId = payload.externalRequestId || "";

  if (!sessionId && !externalRequestId) {
    sendJson(res, 400, { ok: false, message: "sessionId or externalRequestId is required." });
    return;
  }

  try {
    const lookup = buildResultLookup({ apiKey: SOLA_API_KEY, sessionId, externalRequestId });
    const result = await callSolaDevice("/session/result", lookup);
    const interpreted = interpretResult(result.data);

    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        message: result.data.xError || result.data.message || "Sola result lookup failed.",
        raw: result.data,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      approved: interpreted.approved,
      pending: interpreted.pending,
      declined: interpreted.declined,
      status: interpreted.status,
      refNum: result.data.xRefnum || result.data.xRefNum || "",
      authCode: result.data.xAuthCode || "",
      cardType: result.data.xCardType || "",
      maskedCardNumber: result.data.xMaskedCardNumber || "",
      message: result.data.xError || result.data.xResult || interpreted.status,
      raw: result.data,
    });
  } catch (error) {
    logger.error("solaDeviceResult failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Sola result lookup failed." });
  }
});

function tomorrowDateString() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function todayDateString() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

// Year-month stamp (e.g. "2026-06"), used to dedupe monthly reminders so a
// recurring plan is only reminded once per calendar month.
function monthStamp() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// True when a monthly plan's refill day-of-month matches today. Days past the
// end of a shorter month (e.g. the 31st in February) fire on the last day.
function isMonthlyRefillDueToday(refillDate) {
  const parts = String(refillDate || "").trim().split("-");
  if (parts.length < 3) return false;
  const refillDay = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(refillDay)) return false;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const effectiveDay = Math.min(refillDay, daysInMonth);
  return now.getDate() === effectiveDay;
}

function buildSimExpiryMessage(cardLast4) {
  const last4 = String(cardLast4 || "").replace(/\D/g, "").slice(-4);
  const cardPart = last4
    ? `We will charge the card ending in ${last4} to refill it.`
    : "We will charge your card on file to refill it.";
  return `Diamant Telecom: your SIM is about to expire. ${cardPart} If you do not want to refill, or you want to change the card on file, please give us a call.`;
}

exports.sendRentalReturnReminders = onSchedule(
  {
    region: REGION,
    schedule: "every day 10:00",
    timeZone: RENTAL_REMINDER_TIME_ZONE,
  },
  async () => {
    const tomorrow = tomorrowDateString();
    const snapshot = await db
      .collection("reports")
      .where("type", "==", "rental")
      .where("details.returnDueDate", "==", tomorrow)
      .limit(500)
      .get();

    const body = "Hi, this is a friendly reminder from Diamant Telecom to return the phone you rented from us by tomorrow to avoid extra charges.";

    await Promise.all(snapshot.docs.map(async (doc) => {
      const report = doc.data() || {};
      const logId = `rental-return-reminder-${doc.id}-${tomorrow}`;
      const logRef = db.collection("notificationLogs").doc(logId);
      const existingLog = await logRef.get();
      if (existingLog.exists) return;

      const method = report.details?.returnReminderPreference || "Text message";
      const to = report.customerPhone || "";

      if (!to) {
        await writeNotificationLog(logId, doc.id, report, method, "Skipped", "No customer phone number", "rental-return-reminder");
        return;
      }

      try {
        const result = await sendCustomerNotification({ to, method, body });
        await writeNotificationLog(logId, doc.id, report, method, result.status, result.detail, "rental-return-reminder");
      } catch (error) {
        logger.error("sendRentalReturnReminders failed", error);
        await writeNotificationLog(logId, doc.id, report, method, "Failed", error.message, "rental-return-reminder");
      }
    }));
  },
);

// On a SIM activation's chosen reminder date, text or call the customer that
// their SIM is about to expire and the card on file will be charged to refill.
exports.sendSimExpiryReminders = onSchedule(
  {
    region: REGION,
    schedule: "every day 10:00",
    timeZone: RENTAL_REMINDER_TIME_ZONE,
  },
  async () => {
    const today = todayDateString();

    // Send a single SIM reminder/refill notification and log the outcome.
    const sendSimReminder = async (doc, logId, type) => {
      const report = doc.data() || {};
      const logRef = db.collection("notificationLogs").doc(logId);
      const existingLog = await logRef.get();
      if (existingLog.exists) return;

      const method = report.details?.reminderPreference || "Text message";
      const to = report.customerPhone || "";
      if (!to) {
        await writeNotificationLog(logId, doc.id, report, method, "Skipped", "No customer phone number", type);
        return;
      }

      const body = buildSimExpiryMessage(report.details?.cardLast4);

      try {
        const result = await sendCustomerNotification({ to, method, body });
        await writeNotificationLog(logId, doc.id, report, method, result.status, result.detail, type);
      } catch (error) {
        logger.error("sendSimExpiryReminders failed", error);
        await writeNotificationLog(logId, doc.id, report, method, "Failed", error.message, type);
      }
    };

    // One-time plans: fire a single reminder on the chosen reminder date.
    const oneTimeSnapshot = await db
      .collection("reports")
      .where("type", "==", "sim")
      .where("details.reminderDate", "==", today)
      .limit(500)
      .get();

    // Monthly (running) plans: remind every month on the chosen refill day.
    const monthlySnapshot = await db
      .collection("reports")
      .where("type", "==", "sim")
      .where("details.planType", "==", "Monthly")
      .limit(500)
      .get();

    const stamp = monthStamp();

    await Promise.all([
      ...oneTimeSnapshot.docs.map((doc) =>
        sendSimReminder(doc, `sim-expiry-reminder-${doc.id}-${today}`, "sim-expiry-reminder")),
      ...monthlySnapshot.docs
        .filter((doc) => isMonthlyRefillDueToday(doc.data()?.details?.refillDate))
        .map((doc) =>
          sendSimReminder(doc, `sim-monthly-reminder-${doc.id}-${stamp}`, "sim-monthly-reminder")),
    ]);
  },
);

function buildPhoneOrderHandlerMessage(order) {
  const deliverTo = order.deliveryAddress || order.address || "-";
  const hasSeparateDelivery = order.deliveryAddress
    && order.address
    && order.deliveryAddress !== order.address;
  return [
    `Phone order assigned: ${order.model || "phone order"}.`,
    `Customer: ${order.customerName || "-"} ${order.customerPhone || ""}.`,
    `Deliver to: ${deliverTo}.`,
    hasSeparateDelivery ? `(Customer address on file: ${order.address}.)` : "",
    `Total: ${order.orderTotal || "0"}.`,
    `Payment: ${order.paymentStatus || "Collect payment"}.`,
    order.contactDetails ? `Contact: ${order.contactDetails}.` : "",
    order.notes ? `Notes: ${order.notes}.` : "",
  ].filter(Boolean).join(" ");
}

exports.notifyPhoneOrderAssigned = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const order = getPayload(req);
    const customerBody = `Diamant Telecom: your phone order for ${order.model || "your phone"} was assigned to ${order.assignedTo || "our team"}. We will contact you with updates.`;
    const handlerBody = buildPhoneOrderHandlerMessage(order);
    const results = [];

    if (order.customerPhone) {
      results.push({
        to: order.customerPhone,
        ...(await sendCustomerNotification({ to: order.customerPhone, method: "Text message", body: customerBody })),
      });
    }

    if (order.assignedPhone) {
      results.push({
        to: order.assignedPhone,
        ...(await sendCustomerNotification({ to: order.assignedPhone, method: "Text message", body: handlerBody })),
      });
    }

    // Only record problems — successful sends are not logged to keep the
    // notification log focused on what needs attention.
    const failures = results.filter((result) => result.status !== "Sent");
    if (failures.length) {
      await db.collection("notificationLogs").add({
        reportId: order.id || "",
        type: "phone-order-assigned",
        customerPhone: order.customerPhone || "",
        assignedPhone: order.assignedPhone || "",
        status: "Failed",
        detail: JSON.stringify(failures),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    sendJson(res, 200, { ok: true, results });
  } catch (error) {
    logger.error("notifyPhoneOrderAssigned failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Phone order assignment notification failed." });
  }
});

exports.notifyPhoneOrderDelivered = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const order = getPayload(req);
    const body = `Diamant Telecom: your phone order for ${order.model || "your phone"} has been delivered. Thank you.`;

    if (!order.customerPhone) {
      sendJson(res, 400, { ok: false, message: "customerPhone is required." });
      return;
    }

    const result = await sendCustomerNotification({ to: order.customerPhone, method: "Text message", body });
    // Log only when the send didn't succeed.
    if (result.status !== "Sent") {
      await db.collection("notificationLogs").add({
        reportId: order.id || "",
        type: "phone-order-delivered",
        customerPhone: order.customerPhone || "",
        status: result.status,
        detail: result.detail,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    logger.error("notifyPhoneOrderDelivered failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Phone order delivered notification failed." });
  }
});
