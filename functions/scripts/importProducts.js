// One-off: bulk-load a Shopify product export (CSV) into the "products"
// collection, in the exact shape the app's Add Product form writes (id, sku,
// name, price, category, requiresImei, location, imeis, quantity, timestamps).
//
// Each *sellable variant* becomes its own catalog row so it can be scanned at
// the POS. Drafts and Shopify's $0.01 "Item Customizations" helper are skipped.
// Re-running is safe: a SKU already in Firestore is left untouched.
//
//   GOOGLE_APPLICATION_CREDENTIALS=key.json node scripts/importProducts.js [path-to-csv]
//   (or: gcloud auth application-default login, then run without the env var)
//
// Defaults to the Downloads export if no path is given.

const admin = require("firebase-admin");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const args = process.argv.slice(2);
// --backfill: don't add new rows; just fill in the barcode on products already
// in Firestore (matched by SKU) that are missing one. Safe to re-run.
const backfillOnly = args.includes("--backfill");
const file =
  args.find((arg) => !arg.startsWith("--")) ||
  path.join(os.homedir(), "Downloads", "products_export_1.csv");

if (!fs.existsSync(file)) {
  console.error(`CSV not found: ${file}`);
  console.error("Usage: node scripts/importProducts.js [path-to-csv]");
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();
// gRPC is blocked on some networks (NetFree); REST uses plain HTTPS.
db.settings({ preferRest: true });

// --- CSV parsing (RFC 4180: handles quoted fields with commas/quotes/newlines) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      // ignore; \n handles the line break
    } else {
      field += char;
    }
  }
  // flush trailing field/row (file may not end with a newline)
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- mapping helpers ---
function categorize(shopifyCategory) {
  const c = String(shopifyCategory || "").toLowerCase();
  if (c.includes("mobile & smart phones")) return "Phone";
  if (c.includes("sim cards")) return "SIM";
  return "Accessory";
}

function buildName(title, options) {
  const extras = options
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.toLowerCase() !== "default title");
  return extras.length ? `${title} - ${extras.join(" / ")}` : title;
}

(async () => {
  const raw = fs.readFileSync(file, "utf8");
  const table = parseCsv(raw);
  if (!table.length) {
    console.error("Empty CSV.");
    process.exit(1);
  }

  const header = table[0];
  const col = (name) => header.indexOf(name);
  const idx = {
    handle: col("Handle"),
    title: col("Title"),
    category: col("Product Category"),
    status: col("Status"),
    opt1: col("Option1 Value"),
    opt2: col("Option2 Value"),
    opt3: col("Option3 Value"),
    sku: col("Variant SKU"),
    barcode: col("Variant Barcode"),
    price: col("Variant Price"),
  };
  for (const [key, value] of Object.entries(idx)) {
    if (value === -1) {
      console.error(`CSV is missing an expected column for "${key}".`);
      process.exit(1);
    }
  }

  // Carry product-level fields (title/category/status) down to variant rows,
  // which Shopify leaves blank on every row after the first of each product.
  const groups = new Map();
  let current = null;
  for (let r = 1; r < table.length; r += 1) {
    const cells = table[r];
    const handle = (cells[idx.handle] || "").trim();
    if (!handle) continue;
    if (cells[idx.title] && cells[idx.title].trim()) {
      current = {
        handle,
        title: cells[idx.title].trim(),
        category: (cells[idx.category] || "").trim(),
        status: (cells[idx.status] || "").trim(),
        variants: [],
      };
      groups.set(handle + "::" + r, current);
    }
    if (!current) continue;
    const price = (cells[idx.price] || "").trim();
    if (!price) continue; // image-only rows have no price
    current.variants.push({
      price,
      sku: (cells[idx.sku] || "").trim(),
      barcode: (cells[idx.barcode] || "").trim(),
      options: [cells[idx.opt1], cells[idx.opt2], cells[idx.opt3]],
    });
  }

  const now = new Date().toISOString();
  const products = [];
  const usedSkus = new Set();
  let skippedDraft = 0;
  let skippedZero = 0;

  for (const group of groups.values()) {
    if (group.status && group.status.toLowerCase() !== "active") {
      skippedDraft += group.variants.length || 1;
      continue;
    }
    const category = categorize(group.category);
    group.variants.forEach((variant, variantIndex) => {
      if (!(Number(variant.price) >= 1)) {
        skippedZero += 1; // drops the $0.01 "Item Customizations" helper, etc.
        return;
      }
      let sku = variant.sku || variant.barcode || group.handle;
      if (variantIndex > 0 && sku === group.handle) sku = `${group.handle}-${variantIndex + 1}`;
      // Keep every variant even when the export reuses a barcode: make it unique.
      let unique = sku;
      let suffix = 2;
      while (usedSkus.has(unique)) {
        unique = `${sku}-${suffix}`;
        suffix += 1;
      }
      usedSkus.add(unique);

      products.push({
        id: crypto.randomUUID(),
        sku: unique,
        barcode: variant.barcode || "",
        name: buildName(group.title, variant.options),
        price: variant.price,
        category,
        requiresImei: false,
        location: "",
        imeis: [],
        quantity: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  console.log(
    `Parsed ${groups.size} products -> ${products.length} sellable variants ` +
      `(skipped ${skippedDraft} draft, ${skippedZero} zero-price).`,
  );

  const snap = await db.collection("products").get();

  // Backfill mode: only fill in missing barcodes on existing rows (match by SKU).
  if (backfillOnly) {
    const barcodeBySku = new Map();
    for (const product of products) {
      if (product.barcode) barcodeBySku.set(product.sku.toLowerCase(), product.barcode);
    }
    const updates = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const sku = String(data.sku || "").trim().toLowerCase();
      const barcode = barcodeBySku.get(sku);
      if (barcode && !String(data.barcode || "").trim()) {
        updates.push({ ref: doc.ref, barcode });
      }
    });
    console.log(`Backfilling barcode on ${updates.length} of ${snap.size} products.`);
    const chunk = 450;
    for (let i = 0; i < updates.length; i += chunk) {
      const batch = db.batch();
      for (const { ref, barcode } of updates.slice(i, i + chunk)) {
        batch.update(ref, { barcode, updatedAt: new Date().toISOString() });
      }
      await batch.commit();
      console.log(`Updated ${Math.min(i + chunk, updates.length)}/${updates.length}.`);
    }
    console.log("Done.");
    process.exit(0);
  }

  // Idempotency: don't re-add a SKU that already exists in the catalog.
  const existing = new Set();
  snap.forEach((doc) => {
    const sku = doc.data().sku;
    if (sku) existing.add(String(sku).trim());
  });
  const toWrite = products.filter((product) => !existing.has(product.sku));
  console.log(
    `${existing.size} products already in Firestore; writing ${toWrite.length} new, ` +
      `skipping ${products.length - toWrite.length} already-present SKUs.`,
  );

  if (!toWrite.length) {
    console.log("Nothing to write.");
    process.exit(0);
  }

  const chunkSize = 450;
  for (let i = 0; i < toWrite.length; i += chunkSize) {
    const batch = db.batch();
    for (const product of toWrite.slice(i, i + chunkSize)) {
      batch.set(db.collection("products").doc(product.id), product);
    }
    await batch.commit();
    console.log(`Wrote ${Math.min(i + chunkSize, toWrite.length)}/${toWrite.length}.`);
  }

  console.log("Done.");
  process.exit(0);
})().catch((error) => {
  console.error("Import failed:", error.message || error);
  process.exit(1);
});
