const crypto = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const twilio = require("twilio");

admin.initializeApp();

const db = admin.firestore();
const REGION = "us-central1";
const STORE_PHONE_NUMBER = process.env.STORE_PHONE_NUMBER || "+15555555555";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_REQUEST_TOKEN = process.env.TWILIO_REQUEST_TOKEN || "";
const RCUK_API_KEY = process.env.RCUK_API_KEY || "";
const RCUK_API_BASE_URL = process.env.RCUK_API_BASE_URL || "https://myaccount.rcuk.com/api";
const RCUK_ADD_RENTAL_PATH = process.env.RCUK_ADD_RENTAL_PATH || "/rental/add-rental";
const RCUK_GET_RENTAL_PATH = process.env.RCUK_GET_RENTAL_PATH || "/rental/get-rental";
const SOLA_API_KEY = process.env.SOLA_API_KEY || "";
const SOLA_API_BASE_URL = process.env.SOLA_API_BASE_URL || "https://x1.cardknox.com";
const SOLA_CREATE_CHARGE_PATH = process.env.SOLA_CREATE_CHARGE_PATH || "/gatewayjson";
const RENTAL_REMINDER_TIME_ZONE = process.env.RENTAL_REMINDER_TIME_ZONE || "America/New_York";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

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

async function callRcuk(path, payload) {
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

  const response = await fetch(`${RCUK_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": RCUK_API_KEY,
    },
    body: JSON.stringify(payload),
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

function normalizeReportDoc(snapshot) {
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    ...data,
    details: data.details || {},
  };
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortNewestFirst(items) {
  return items.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
}

function buildRepairMessage(report) {
  const status = report.details.status || "Received";
  const paymentStatus = report.details.paymentStatus || "Not paid";
  const dueDate = report.details.dueDate ? ` Expected ready date is ${report.details.dueDate}.` : "";
  const paidMessage = paymentStatus === "Paid"
    ? "Payment is marked paid."
    : "Payment is not marked paid yet.";

  return `${paidMessage}${dueDate}`;
}

async function findRepairByLookup(lookupValue) {
  const lookupDigits = digitsOnly(lookupValue);
  if (!lookupDigits) return null;

  const repairSnapshot = await db
    .collection("reports")
    .where("type", "==", "repair")
    .limit(250)
    .get();

  const matches = repairSnapshot.docs
    .map(normalizeReportDoc)
    .filter((report) => {
      const phoneDigits = report.customerPhoneDigits || digitsOnly(report.customerPhone);
      const ticketDigits = report.ticketDigits || digitsOnly(report.details.ticketNumber);
      return phoneDigits === lookupDigits || ticketDigits === lookupDigits;
    });

  return sortNewestFirst(matches)[0] || null;
}

exports.repairStatus = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  if (!assertTwilioRequest(req, res)) return;

  try {
    const payload = getPayload(req);
    const lookup = payload.ticketLookup || payload.phone || payload.lookup || payload.Digits || "";
    const repair = await findRepairByLookup(lookup);

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

exports.phoneInventoryList = onRequest({ region: REGION }, async (req, res) => {
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

exports.phoneInventoryDetails = onRequest({ region: REGION }, async (req, res) => {
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
    if (oldStatus === "Delivered" || newStatus !== "Delivered") return;

    const to = after.customerPhone;
    if (!to) {
      await logNotification(event.params.reportId, after, "Skipped", "No customer phone number");
      return;
    }

    const client = getTwilioClient();
    if (!client) {
      await logNotification(
        event.params.reportId,
        after,
        "Queued",
        "Twilio credentials are not configured",
      );
      return;
    }

    const body = `Diamant Telecom: repair ticket ${after.details?.ticketNumber || ""} for ${after.details?.model || "your phone"} is marked delivered.`;
    const method = after.details?.notificationPreference || "Text message";

    try {
      if (method === "Phone call") {
        const twiml = `<Response><Say>${escapeXml(body)}</Say></Response>`;
        const call = await client.calls.create({
          to,
          from: TWILIO_FROM_NUMBER,
          twiml,
        });
        await logNotification(event.params.reportId, after, "Sent", `Call ${call.sid}`);
        return;
      }

      const message = await client.messages.create({
        to,
        from: TWILIO_FROM_NUMBER,
        body,
      });
      await logNotification(event.params.reportId, after, "Sent", `SMS ${message.sid}`);
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

exports.shopifyOrderWebhook = onRequest({ region: REGION }, async (req, res) => {
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

    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
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
      notes: "Imported from Shopify POS. Employee must claim and complete missing fields.",
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
        staffName: order.staff_member?.name || "",
        staffId: order.staff_member?.id ? String(order.staff_member.id) : "",
        locationName: order.location?.name || "",
        locationId: order.location_id ? String(order.location_id) : "",
        lineItems,
        lineItemsText,
        paymentGatewayNames: order.payment_gateway_names || [],
        financialStatus: order.financial_status || "",
        fulfillmentStatus: order.fulfillment_status || "",
      },
      details: {
        request: "Shopify POS sale",
        productType: "Shopify order",
        model: lineItemsText,
        imei: "",
        lineItems,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  sendJson(res, 200, { ok: true });
});

function extractRentalId(data) {
  return data.rental_id
    || data.rentalId
    || data.id
    || data.data?.rental_id
    || data.data?.rentalId
    || data.rental_data?.rental_id
    || data.rental_data?.id
    || "";
}

function normalizeRentalLookup(data) {
  const rentalData = data.rental_data || data.data || data;
  const cli = rentalData.cli || rentalData.CLI || rentalData.phone_number || "";
  const usDdi = rentalData.us_ddi || rentalData.usDDI || rentalData.usa_number || rentalData.us_number || "";

  return {
    rentalId: extractRentalId(data),
    cli,
    usDdi,
    pending: !cli && !usDdi,
    raw: data,
  };
}

exports.rcukAddRental = onRequest({ region: REGION }, async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST required" });
    return;
  }

  try {
    const payload = getPayload(req);
    const result = await callRcuk(RCUK_ADD_RENTAL_PATH, payload);
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

exports.rcukGetRental = onRequest({ region: REGION }, async (req, res) => {
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

    const result = await callRcuk(RCUK_GET_RENTAL_PATH, { rental_id: rentalId });
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

exports.solaCreateCharge = onRequest({ region: REGION }, async (req, res) => {
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

exports.notifyPhoneOrderAssigned = onRequest({ region: REGION }, async (req, res) => {
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

exports.notifyPhoneOrderDelivered = onRequest({ region: REGION }, async (req, res) => {
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
