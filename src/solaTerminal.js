import { FUNCTIONS_BASE_URL } from "./constants";

// Card-present payments run through Sola CloudIM: our Cloud Function starts a
// sale on the physical terminal (PAX A80), then we poll for the result while
// the customer taps / dips / swipes their card. No card data touches the browser.

async function postJson(path, body) {
  const response = await fetch(`${FUNCTIONS_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `Request to ${path} failed.`);
  }
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start a sale on the terminal and poll until it is approved, declined, or the
// poll window runs out. `onStatus` receives human-readable progress updates.
export async function chargeOnDevice({
  amount,
  deviceId,
  location,
  customerPhone,
  externalRequestId,
  manualEntry = false,
  onStatus,
  pollIntervalMs = 2500,
  timeoutMs = 120000,
} = {}) {
  if (!FUNCTIONS_BASE_URL) {
    throw new Error("Set VITE_FUNCTIONS_BASE_URL to your Firebase Functions URL to use the card terminal.");
  }
  if (!deviceId) {
    throw new Error("No terminal is assigned to this store. Set a Sola device ID in Inventory.");
  }

  const requestId = externalRequestId || `pos-${Date.now()}`;
  onStatus?.("Sending sale to the terminal...");
  const started = await postJson("/solaDeviceSale", {
    amount,
    deviceId,
    location,
    customerPhone,
    externalRequestId: requestId,
    manualEntry,
  });

  const sessionId = started.sessionId || "";
  onStatus?.(manualEntry
    ? "Follow the terminal: key in the card number by hand."
    : "Follow the terminal: tap, insert, or swipe the card.");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    const result = await postJson("/solaDeviceResult", {
      sessionId,
      externalRequestId: requestId,
    });

    if (result.approved) {
      return {
        status: "approved",
        refNum: result.refNum || "",
        authCode: result.authCode || "",
        cardType: result.cardType || "",
        maskedCardNumber: result.maskedCardNumber || "",
      };
    }
    if (result.declined) {
      throw new Error(result.message || "Card was declined.");
    }
    if (!result.pending && result.status && result.status.toLowerCase() === "error") {
      throw new Error(result.message || "Terminal returned an error.");
    }
  }

  throw new Error("Timed out waiting for the terminal. Check the card was presented and try again.");
}

// Refund a previous card sale back to the original card by reference number.
export async function refundToCard({ amount, refNum }) {
  if (!FUNCTIONS_BASE_URL) {
    throw new Error("Set VITE_FUNCTIONS_BASE_URL to your Firebase Functions URL to refund cards.");
  }
  if (!refNum) {
    throw new Error("This sale has no card reference, so it can't be refunded to the card automatically.");
  }
  const result = await postJson("/solaRefund", { amount, refNum });
  return { refNum: result.transactionId || refNum, status: result.status || "refunded" };
}
