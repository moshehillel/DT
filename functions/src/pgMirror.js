// Copies every Firestore document into PostgreSQL unchanged. Firestore is only
// read. Each document is stored whole as JSON, with Firestore-only types
// tagged so nothing about the value is lost, plus a few columns pulled out for
// searching. A document that disappears from Firestore is marked, never removed.

const crypto = require("node:crypto");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

// Firestore values that have no JSON form keep their type in a tag.
function encodeValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $number: String(value) };
  }
  if (typeof value === "string" && value.includes("\u0000")) {
    return { $text: Buffer.from(value, "utf8").toString("base64") };
  }
  if (typeof value !== "object") return value;
  if (typeof value.toDate === "function" && typeof value.seconds === "number") {
    return { $timestamp: value.toDate().toISOString(), seconds: value.seconds, nanoseconds: value.nanoseconds || 0 };
  }
  if (typeof value.latitude === "number" && typeof value.longitude === "number" && !isPlainObject(value)) {
    return { $geopoint: { latitude: value.latitude, longitude: value.longitude } };
  }
  if (typeof value.path === "string" && typeof value.firestore === "object") {
    return { $ref: value.path };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (typeof value.toBase64 === "function") {
    return { $bytes: value.toBase64() };
  }
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key.includes("\u0000") ? key.replace(/\u0000/g, "\\u0000") : key] = encodeValue(inner);
  }
  return out;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintOf(encoded) {
  return crypto.createHash("sha256").update(stableStringify(encoded)).digest("hex");
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 500) : null;
}

function amountOrNull(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function timeOrNull(value) {
  if (!value) return null;
  if (typeof value === "object" && value.$timestamp) return value.$timestamp;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Columns for searching. The whole document stays in `data`; these never
// replace it, so a value that doesn't parse here is still kept there.
function searchColumns(encoded) {
  const data = encoded || {};
  const details = isPlainObject(data.details) ? data.details : {};
  const phone = data.customerPhoneDigits || data.customerPhone || data.phone || "";
  return {
    docType: textOrNull(data.type),
    createdAt: timeOrNull(data.createdAt),
    location: textOrNull(data.location || details.location),
    customerPhone: textOrNull(String(phone).replace(/\D/g, "")),
    amount: amountOrNull(data.paymentAmount ?? data.orderTotal ?? data.amount),
  };
}

function toRow(collection, id, rawData, updateTime) {
  const data = encodeValue(rawData || {});
  return {
    collection,
    id,
    data,
    fingerprint: fingerprintOf(data),
    updateTime: updateTime ? updateTime.toDate().toISOString() : null,
    ...searchColumns(data),
  };
}

// Compares what Firestore had with what PostgreSQL now holds for one collection.
function compareCollection(firestoreRows, storedFingerprints) {
  const mismatched = [];
  for (const row of firestoreRows) {
    if (storedFingerprints.get(row.id) !== row.fingerprint) mismatched.push(row.id);
  }
  return {
    firestoreCount: firestoreRows.length,
    storedCount: firestoreRows.filter((row) => storedFingerprints.has(row.id)).length,
    mismatched,
  };
}

module.exports = {
  compareCollection,
  encodeValue,
  fingerprintOf,
  searchColumns,
  stableStringify,
  toRow,
};
