// What one save does to one document, worked out the way Firestore would:
// `set` replaces the document, `merge` folds nested maps into it (arrays and
// other values are replaced), `delete` removes it. Permissions are the same
// as firestore.rules, so a save refused there is refused here.

const STOCK_FIELDS = ["stock", "quantity", "imeis"];

const MAX_OPS = 500;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

// Catalog saves never carry stock; the stock function is the only writer.
function withoutStock(collection, data) {
  if (collection !== "products" || !isPlainObject(data)) return data;
  const copy = { ...data };
  for (const field of STOCK_FIELDS) delete copy[field];
  return copy;
}

function nextData(existing, op) {
  if (op.type === "delete") return null;
  const data = withoutStock(op.collection, op.data || {});
  if (op.type === "merge") return deepMerge(existing || {}, data);
  if (op.collection === "products") {
    // A product is always merged so its stock stays where it was.
    return deepMerge(existing || {}, data);
  }
  return data;
}

const allow = () => true;
const admin = (auth) => auth.admin;
const never = () => false;

const RULES = {
  employees: { create: admin, update: admin, delete: admin },
  appState: { create: allow, update: allow, delete: allow },
  reports: { create: allow, update: allow, delete: admin },
  pendingReports: {
    create: admin,
    update: (auth, existing) => auth.admin || !existing?.claimedBy,
    delete: (auth, existing) => auth.admin
      || Boolean(existing?.claimedBy)
      || Boolean(existing?.servedBy)
      || existing?.source === "shopify_pos",
  },
  phoneOrders: { create: allow, update: allow, delete: allow },
  orderHandlers: { create: allow, update: allow, delete: admin },
  inventoryPhones: { create: admin, update: admin, delete: admin },
  products: { create: allow, update: allow, delete: admin },
  stockMovements: { create: never, update: never, delete: never },
  inventoryBalances: { create: never, update: never, delete: never },
  cardRefunds: { create: never, update: never, delete: never },
  customers: { create: allow, update: allow, delete: admin },
  rentalPhones: { create: allow, update: allow, delete: admin },
  repairTickets: { create: allow, update: never, delete: admin },
  stockWaitlist: { create: allow, update: allow, delete: allow },
  notificationLogs: { create: allow, update: admin, delete: admin },
  passwordResetRequests: { create: allow, update: admin, delete: admin },
};

function actionOf(existing, op) {
  if (op.type === "delete") return "delete";
  return existing ? "update" : "create";
}

function permitted(auth, existing, op) {
  if (!auth?.uid) return false;
  const rule = RULES[op.collection];
  if (!rule) return false;
  return Boolean(rule[actionOf(existing, op)](auth, existing, op));
}

const ID_PATTERN = /^[^/]{1,1500}$/;

function normalizeOps(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error("Nothing to save.");
  if (raw.length > MAX_OPS) throw new Error(`Save at most ${MAX_OPS} records at a time.`);
  return raw.map((entry) => {
    const collection = String(entry?.collection || "");
    const id = String(entry?.id ?? "");
    const type = String(entry?.type || "");
    if (!RULES[collection]) throw new Error(`Unknown collection "${collection}".`);
    if (!ID_PATTERN.test(id) || id === "." || id === "..") throw new Error("A record id is not valid.");
    if (!["set", "merge", "delete"].includes(type)) throw new Error("Save type is not valid.");
    if (type !== "delete" && !isPlainObject(entry.data)) throw new Error("A record has no data.");
    return { collection, id, type, data: type === "delete" ? null : entry.data };
  });
}

module.exports = {
  MAX_OPS,
  STOCK_FIELDS,
  actionOf,
  deepMerge,
  nextData,
  normalizeOps,
  permitted,
  withoutStock,
};
