// Card-present payments on the Verifone P200 run through Sola BBPOS
// ("PaymentEngineExt"): a small tray app that runs in the background on this
// same POS computer and exposes a local HTTPS server at https://localemv.com:8887.
// The browser posts the sale to that local agent, which drives the P200 over
// USB/LAN and returns the result. The Cardknox API key is configured inside the
// tray app, so it never touches the browser — and no card data passes through
// here either.
//
// Unlike the old CloudIM flow, there is no Cloud Function and no polling: the
// single request to the agent stays open until the customer taps / dips / swipes
// (or it times out).

const BBPOS_URL = "https://localemv.com:8887/";
const SOFTWARE_NAME = "Diamant Telecom Reports";
const SOFTWARE_VERSION = "0.1.0";
// Cardknox PaymentEngine request schema version.
const API_VERSION = "5.0.0";

function formatAmount(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return amount.toFixed(2);
}

// The agent can answer as JSON or as URL-encoded key/value pairs depending on
// configuration; accept either.
function parseResponse(text) {
  const body = String(text || "").trim();
  if (!body) return {};
  if (body.startsWith("{")) {
    try {
      return JSON.parse(body);
    } catch {
      // fall through to KVP parsing
    }
  }
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

// CloudIM-style single-letter result codes: A = approved, D = declined,
// E = error, I = in progress.
function interpret(data) {
  const result = String(data.xResult || "").toUpperCase();
  const status = String(data.xStatus || "").trim().toLowerCase();
  return {
    approved: result === "A" || status === "approved",
    declined: result === "D" || status === "declined",
    error: result === "E" || status === "error",
    status: data.xStatus || data.xResult || "Unknown",
  };
}

// Start a sale on the local Verifone P200 and resolve once it is approved
// (throws on decline / error / timeout). `onStatus` receives progress text.
export async function chargeOnLocalTerminal({
  amount,
  externalRequestId,
  manualEntry = false,
  onStatus,
  timeoutMs = 120000,
} = {}) {
  const cleanAmount = formatAmount(amount);
  if (!cleanAmount) {
    throw new Error("A valid amount is required to charge the card.");
  }

  const body = new URLSearchParams({
    xVersion: API_VERSION,
    xSoftwareName: SOFTWARE_NAME,
    xSoftwareVersion: SOFTWARE_VERSION,
    xCommand: "cc:sale",
    xAmount: cleanAmount,
    xExternalRequestId: String(externalRequestId || `pos-${Date.now()}`).slice(0, 32),
  });

  onStatus?.(manualEntry
    ? "Follow the terminal: key in the card number by hand."
    : "Follow the terminal: tap, insert, or swipe the card.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(BBPOS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Timed out waiting for the terminal. Check the card was presented and try again.");
    }
    // A failed fetch to localhost almost always means the agent isn't running.
    throw new Error("Can't reach the card terminal app (Sola BBPOS). Make sure it's installed and running on this computer.");
  } finally {
    clearTimeout(timer);
  }

  const data = parseResponse(await response.text().catch(() => ""));
  const outcome = interpret(data);

  if (outcome.approved) {
    return {
      status: "approved",
      refNum: data.xRefNum || data.xRefnum || "",
      authCode: data.xAuthCode || "",
      cardType: data.xCardType || "",
      maskedCardNumber: data.xMaskedCardNumber || "",
    };
  }
  if (outcome.declined) {
    throw new Error(data.xError || "Card was declined.");
  }
  throw new Error(data.xError || "The terminal returned an error. Try again.");
}
