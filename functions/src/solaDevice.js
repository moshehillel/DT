// Helpers for Sola / Cardknox CloudIM card-present payments. CloudIM talks to a
// physical terminal (e.g. PAX A80) over the cloud, so the browser POS never
// touches the card data and the API key stays on the backend.
//
// Flow: POST /v2/session/async to start a sale, then poll POST /v2/session/result
// until the terminal returns an Approved / Declined / Error status.

const SOFTWARE_NAME = "Diamant Telecom Reports";
const SOFTWARE_VERSION = "0.1.0";

function formatAmount(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return amount.toFixed(2);
}

function buildSaleSession({ apiKey, deviceId, amount, externalRequestId, tip, enableTipPrompt, manualEntry }) {
  const session = {
    xKey: apiKey,
    xDeviceId: deviceId,
    xCommand: "cc:sale",
    xAmount: formatAmount(amount),
    xExternalRequestId: String(externalRequestId || "").slice(0, 32),
    xSoftwareName: SOFTWARE_NAME,
    xSoftwareVersion: SOFTWARE_VERSION,
  };

  const tipAmount = formatAmount(tip);
  if (tipAmount) session.xTip = tipAmount;
  if (enableTipPrompt) session.xEnableTipPrompt = true;
  // Ask the terminal to prompt for a hand-keyed card number instead of
  // tap/dip/swipe. The terminal still allows manual entry without this hint.
  if (manualEntry) session.xManualEntry = true;

  return session;
}

function buildResultLookup({ apiKey, sessionId, externalRequestId }) {
  const lookup = { xKey: apiKey };
  if (sessionId) lookup.xSessionId = sessionId;
  else if (externalRequestId) lookup.xExternalRequestId = String(externalRequestId).slice(0, 32);
  return lookup;
}

// CloudIM uses single-letter result codes: A = approved, D = declined,
// E = error, I = in progress.
function interpretResult(data) {
  const result = String(data.xResult || "").toUpperCase();
  const status = String(data.xStatus || "").trim();

  return {
    approved: result === "A" || status.toLowerCase() === "approved",
    pending: result === "I" || status.toLowerCase() === "inprogress" || status.toLowerCase() === "in progress",
    declined: result === "D" || status.toLowerCase() === "declined",
    error: result === "E" || status.toLowerCase() === "error",
    status: status || result || "Unknown",
  };
}

module.exports = {
  buildResultLookup,
  buildSaleSession,
  formatAmount,
  interpretResult,
};
