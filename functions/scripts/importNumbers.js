// One-off: bulk-load phone numbers into the CRM "customers" collection (no names).
// Dedupes, normalizes to 10-digit local, formats, and skips numbers already present.
//
//   GOOGLE_APPLICATION_CREDENTIALS=key.json node scripts/importNumbers.js <path-to-numbers-file>

const admin = require("firebase-admin");
const fs = require("node:fs");
const crypto = require("node:crypto");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/importNumbers.js <path-to-numbers-file>");
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();
// gRPC is blocked on some networks (NetFree); REST uses plain HTTPS.
db.settings({ preferRest: true });

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");
const normalize = (d) => (d.length === 11 && d.startsWith("1") ? d.slice(1) : d);
function formatPhone(digits) {
  const n = normalize(digits);
  if (n.length === 10) return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  return String(digits);
}

(async () => {
  const raw = fs.readFileSync(file, "utf8");
  const numbers = new Map(); // normalized digits -> formatted phone
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim();
    if (!token || /caller/i.test(token)) continue;
    const norm = normalize(digitsOnly(token));
    if (norm.length !== 10) continue; // skip incomplete / junk entries
    if (!numbers.has(norm)) numbers.set(norm, formatPhone(token));
  }
  console.log(`Parsed ${numbers.size} unique 10-digit numbers.`);

  const snap = await db.collection("customers").get();
  const existing = new Set();
  snap.forEach((doc) => {
    const pd = doc.data().phoneDigits;
    if (pd) existing.add(normalize(digitsOnly(pd)));
  });
  console.log(`Existing customers in CRM: ${snap.size}`);

  const now = new Date().toISOString();
  const toAdd = [];
  for (const [norm, phone] of numbers) {
    if (existing.has(norm)) continue;
    toAdd.push({
      id: crypto.randomUUID(),
      name: "",
      phone,
      phoneDigits: norm,
      address: "",
      email: "",
      contactDetails: "",
      notes: "",
      source: "import",
      createdAt: now,
      updatedAt: now,
    });
  }
  console.log(`New numbers to add: ${toAdd.length}`);

  let added = 0;
  for (let i = 0; i < toAdd.length; i += 450) {
    const batch = db.batch();
    for (const customer of toAdd.slice(i, i + 450)) {
      batch.set(db.collection("customers").doc(customer.id), customer);
    }
    await batch.commit();
    added += Math.min(450, toAdd.length - i);
    console.log(`Committed ${added}/${toAdd.length}`);
  }
  console.log("Done.");
  process.exit(0);
})().catch((error) => {
  console.error("Import failed:", error.message || error);
  process.exit(1);
});
