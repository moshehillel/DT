const IMEI_PROPERTY_NAMES = new Set([
  "imei",
  "device imei",
  "phone imei",
  "serial",
  "serial number",
]);

function normalizeImeiValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 15) {
    return digits.slice(0, 15);
  }

  return raw;
}

function imeiFromProperties(properties) {
  for (const property of properties || []) {
    const name = String(property?.name || "").trim().toLowerCase();
    const value = normalizeImeiValue(property?.value);
    if (!value) continue;

    if (IMEI_PROPERTY_NAMES.has(name) || name.includes("imei")) {
      return value;
    }
  }

  return "";
}

function extractShopifyImei(order) {
  for (const item of order?.line_items || []) {
    const imei = imeiFromProperties(item.properties);
    if (imei) return imei;
  }

  const noteImei = imeiFromProperties(order?.note_attributes);
  if (noteImei) return noteImei;

  return "";
}

module.exports = {
  extractShopifyImei,
  imeiFromProperties,
};
