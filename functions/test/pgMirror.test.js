const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, GeoPoint } = require("firebase-admin/firestore");
const {
  compareCollection,
  encodeValue,
  fingerprintOf,
  searchColumns,
  toRow,
} = require("../src/pgMirror");

test("plain values pass through unchanged", () => {
  const doc = { a: "x", b: 2.5, c: true, d: null, e: [1, "two", { f: false }], g: { h: { i: "deep" } } };
  assert.deepEqual(encodeValue(doc), doc);
});

test("Firestore-only types keep their type in a tag", () => {
  const when = Timestamp.fromDate(new Date("2026-10-07T23:41:32.605Z"));
  const encoded = encodeValue({ at: when, where: new GeoPoint(40.7, -73.9), blob: Buffer.from("hi") });
  assert.equal(encoded.at.$timestamp, "2026-10-07T23:41:32.605Z");
  assert.equal(encoded.at.seconds, when.seconds);
  assert.deepEqual(encoded.where, { $geopoint: { latitude: 40.7, longitude: -73.9 } });
  assert.deepEqual(encoded.blob, { $bytes: Buffer.from("hi").toString("base64") });
});

test("text PostgreSQL can't hold is kept in a tag", () => {
  const encoded = encodeValue({ note: "a\u0000b" });
  assert.equal(Buffer.from(encoded.note.$text, "base64").toString("utf8"), "a\u0000b");
});

test("the fingerprint ignores key order and survives a JSON round trip", () => {
  const a = { x: 1, y: { b: 2, a: [3, 4] } };
  const b = { y: { a: [3, 4], b: 2 }, x: 1 };
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.equal(fingerprintOf(a), fingerprintOf(JSON.parse(JSON.stringify(a))));
  assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, x: 2 }));
});

test("search columns come from a sale without changing it", () => {
  const sale = {
    type: "sale",
    createdAt: "2026-10-07T23:41:32.605Z",
    location: "Brooklyn",
    customerPhone: "(347) 388-7467",
    paymentAmount: "108.88",
    details: { location: "Monroe" },
  };
  assert.deepEqual(searchColumns(sale), {
    docType: "sale",
    createdAt: "2026-10-07T23:41:32.605Z",
    location: "Brooklyn",
    customerPhone: "3473887467",
    amount: 108.88,
  });
  const row = toRow("reports", "r1", sale, null);
  assert.deepEqual(row.data, sale);
});

test("a value that doesn't parse is left out of the columns but kept in the data", () => {
  const odd = { createdAt: "not a date", paymentAmount: "abc" };
  const row = toRow("reports", "r2", odd, null);
  assert.equal(row.createdAt, null);
  assert.equal(row.amount, null);
  assert.deepEqual(row.data, odd);
});

test("the check finds a missing or changed copy", () => {
  const rows = [toRow("c", "1", { a: 1 }, null), toRow("c", "2", { a: 2 }, null), toRow("c", "3", { a: 3 }, null)];
  const stored = new Map([
    ["1", rows[0].fingerprint],
    ["2", fingerprintOf({ a: 999 })],
  ]);
  const result = compareCollection(rows, stored);
  assert.equal(result.firestoreCount, 3);
  assert.equal(result.storedCount, 2);
  assert.deepEqual(result.mismatched, ["2", "3"]);
});
