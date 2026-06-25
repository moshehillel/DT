const crypto = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const twilio = require("twilio");
const {
  buildRcukRentalPayload,
  digitsOnly,
  normalizeRcukSimNumber,
} = require("./rcuk");
const { buildRepairMessage, findRepairByLookup } = require("./repairs");
const {
  buildTelebroadPendingReport,
  shouldImportCall,
} = require("./telebroad");
const { extractShopifyImei } = require("./shopify");

admin.initializeApp();

const db = admin.firestore();
const REGION = "us-central1";
const HTTP_OPTIONS = { region: REGION, invoker: "public" };
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_REQUEST_TOKEN = process.env.TWILIO_REQUEST_TOKEN || "";
const RCUK_API_KEY = process.env.RCUK_API_KEY || "";
const RCUK_API_BASE_URL = process.env.RCUK_API_BASE_URL || "https://myaccount.rcuk.com/api";
const RCUK_ADD_RENTAL_PATH = process.env.RCUK_ADD_RENTAL_PATH || "/add-rental";
const RCUK_GET_RENTAL_PATH = process.env.RCUK_GET_RENTAL_PATH || "/get-rental";
const RCUK_CHECK_SIM_PATH = process.env.RCUK_CHECK_SIM_PATH || "/check-sim";
const SOLA_API_KEY = process.env.SOLA_API_KEY || "";
const SOLA_API_BASE_URL = process.env.SOLA_API_BASE_URL || "https://x1.cardknox.com";
const SOLA_CREATE_CHARGE_PATH = process.env.SOLA_CREATE_CHARGE_PATH || "/gatewayjson";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_CURRENCY = process.env.STRIPE_CURRENCY || "usd";
const RENTAL_REMINDER_TIME_ZONE = process.env.RENTAL_REMINDER_TIME_ZONE || "America/New_York";

// Stripe is only loaded when a secret key is configured so the rest of the
// functions keep working (and deploying) even before Stripe is set up.
const stripeClient = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

function getPayload(req) {
  return {
    ...(req.query || {}),
    ...(typeof req.body === "object" && req.body ? req.body : {}),
  };
}

function sendJson(res, status, body) {
  res.status(status).set("Content-Type", "application/json").send(body);
}

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
    const lookup = payload.ticketLookup || payload.phone || payload.lookup || payload.Digits || "";
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

async function sendCustomerNotification({ to, method, body }) {
  const client = getTwilioClient();
  if (!client) {
    return {
      status: "Queued",
      detail: "Twilio credentials are not configured",
    };
  }

  if (method === "Phone call") {
    const call = await client.calls.create({
      to,
      from: TWILIO_FROM_NUMBER,
      twiml: `<Response><Say>${escapeXml(body)}</Say></Response>`,
    });
    return {
      status: "Sent",
      detail: `Call ${call.sid}`,
    };
  }

  const message = await client.messages.create({
    to,
    from: TWILIO_FROM_NUMBER,
    body,
  });
  return {
    status: "Sent",
    detail: `SMS ${message.sid}`,
  };
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

exports.notifyRepairDelivered = onDocumentUpdated(
  {
    region: REGION,
    document: "reports/{reportId}",
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after || after.type !== "repair") return;

    const oldStatus = before.details?.status;
    const newStatus = after.details?.status;
    if (oldStatus === "Ready" || newStatus !== "Ready") return;

    const to = after.customerPhone;
    if (!to) {
      await logNotification(event.params.reportId, after, "Skipped", "No customer phone number");
      return;
    }

    const body = `Diamant Telecom: repair ticket ${after.details?.ticketNumber || ""} for ${after.details?.model || "your phone"} is ready for pickup.`;
    const method = after.details?.notificationPreference || "Text message";

    try {
      const result = await sendCustomerNotification({ to, method, body });
      await logNotification(event.params.reportId, after, result.status, result.detail);
    } catch (error) {
      logger.error("notifyRepairDelivered failed", error);
      await logNotification(event.params.reportId, after, "Failed", error.message);
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
      paymentMethod: "Shopify POS",
      notes: "Imported from Shopify POS. Employee must complete missing fields.",
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

// Stripe Terminal: hands the browser SDK a short-lived connection token so it
// can discover and connect to a card reader (real or simulated).
exports.stripeConnectionToken = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "POST required" });
    return;
  }
  if (!stripeClient) {
    sendJson(res, 501, {
      ok: false,
      message: "Stripe is not configured yet. Set STRIPE_SECRET_KEY on Firebase Functions.",
    });
    return;
  }

  try {
    const token = await stripeClient.terminal.connectionTokens.create();
    sendJson(res, 200, { ok: true, secret: token.secret });
  } catch (error) {
    logger.error("stripeConnectionToken failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Could not create connection token." });
  }
});

// Stripe Terminal: creates a card-present PaymentIntent for the cart total.
// Manual capture so the sale is only captured after the reader approves.
exports.stripeCreatePaymentIntent = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "POST required" });
    return;
  }
  if (!stripeClient) {
    sendJson(res, 501, {
      ok: false,
      message: "Stripe is not configured yet. Set STRIPE_SECRET_KEY on Firebase Functions.",
    });
    return;
  }

  const payload = getPayload(req);
  const amount = Number.parseFloat(payload.amount || "0");
  if (!Number.isFinite(amount) || amount <= 0) {
    sendJson(res, 400, { ok: false, message: "A valid amount is required." });
    return;
  }

  try {
    const intent = await stripeClient.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: payload.currency || STRIPE_CURRENCY,
      payment_method_types: ["card_present"],
      capture_method: "manual",
      description: payload.description || "Diamant Telecom POS sale",
      metadata: {
        source: "pos",
        location: payload.location || "",
        customerPhone: payload.customerPhone || "",
      },
    });
    sendJson(res, 200, { ok: true, id: intent.id, clientSecret: intent.client_secret });
  } catch (error) {
    logger.error("stripeCreatePaymentIntent failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Could not create payment intent." });
  }
});

// Stripe Terminal: captures the PaymentIntent after the reader processes it.
exports.stripeCapturePaymentIntent = onRequest(HTTP_OPTIONS, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "POST required" });
    return;
  }
  if (!stripeClient) {
    sendJson(res, 501, {
      ok: false,
      message: "Stripe is not configured yet. Set STRIPE_SECRET_KEY on Firebase Functions.",
    });
    return;
  }

  const payload = getPayload(req);
  const paymentIntentId = payload.paymentIntentId || payload.id || "";
  if (!paymentIntentId) {
    sendJson(res, 400, { ok: false, message: "paymentIntentId is required." });
    return;
  }

  try {
    const intent = await stripeClient.paymentIntents.capture(paymentIntentId);
    sendJson(res, 200, { ok: true, id: intent.id, status: intent.status });
  } catch (error) {
    logger.error("stripeCapturePaymentIntent failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Could not capture payment." });
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

function buildPhoneOrderHandlerMessage(order) {
  return [
    `Phone order assigned: ${order.model || "phone order"}.`,
    `Customer: ${order.customerName || "-"} ${order.customerPhone || ""}.`,
    `Address: ${order.address || "-"}.`,
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

    await db.collection("notificationLogs").add({
      reportId: order.id || "",
      type: "phone-order-assigned",
      customerPhone: order.customerPhone || "",
      assignedPhone: order.assignedPhone || "",
      status: results.some((result) => result.status === "Sent") ? "Sent" : "Queued",
      detail: JSON.stringify(results),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
    await db.collection("notificationLogs").add({
      reportId: order.id || "",
      type: "phone-order-delivered",
      customerPhone: order.customerPhone || "",
      status: result.status,
      detail: result.detail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    logger.error("notifyPhoneOrderDelivered failed", error);
    sendJson(res, 500, { ok: false, message: error.message || "Phone order delivered notification failed." });
  }
});
