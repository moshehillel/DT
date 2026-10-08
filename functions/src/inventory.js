// Stock changes are movements against one store. The product document still
// carries every store's balance so the registers can show it, but a movement
// is applied to a fresh read of that document and only the store it names is
// changed. Replaying the same movement id does nothing.

const OPS = new Set(["removeQty", "addQty", "removeImeis", "addImeis", "set"]);

function cleanImeis(list) {
  return [...new Set((list || []).map((value) => String(value || "").replace(/\D/g, "")).filter(Boolean))];
}

function stockMapOf(product) {
  const source = product?.stock;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const copy = {};
    for (const [location, entry] of Object.entries(source)) {
      copy[location] = {
        quantity: Number(entry?.quantity) || 0,
        imeis: Array.isArray(entry?.imeis) ? [...entry.imeis] : [],
      };
    }
    return copy;
  }
  const quantity = Number(product?.quantity) || 0;
  const imeis = Array.isArray(product?.imeis) ? product.imeis : [];
  if (!quantity && !imeis.length) return {};
  return { [product?.location || ""]: { quantity, imeis: [...imeis] } };
}

function normalizeMovement(raw) {
  const id = String(raw?.id || "").trim();
  const productId = String(raw?.productId || "").trim();
  const location = String(raw?.location || "").trim();
  const op = String(raw?.op || "").trim();
  if (!/^[A-Za-z0-9:_-]{6,180}$/.test(id)) {
    throw new Error("Stock movement id is not valid.");
  }
  if (!productId) throw new Error("Stock movement is missing a product.");
  if (!location) throw new Error("Stock movement is missing a store.");
  if (!OPS.has(op)) throw new Error("Stock movement type is not valid.");
  const qty = Math.max(0, Math.round(Number(raw?.qty) || 0));
  const imeis = cleanImeis(raw?.imeis);
  if ((op === "removeQty" || op === "addQty") && qty <= 0) return null;
  if ((op === "removeImeis" || op === "addImeis") && !imeis.length) return null;
  const cost = Number.parseFloat(raw?.unitCost);
  const unitCost = raw?.unitCost !== undefined && raw?.unitCost !== null && raw?.unitCost !== "" && Number.isFinite(cost) && cost >= 0
    ? Math.round(cost * 100) / 100
    : null;
  return {
    unitCost,
    id,
    productId,
    location,
    op,
    qty,
    imeis,
    requiresImei: Boolean(raw?.requiresImei),
    sourceType: String(raw?.sourceType || "").slice(0, 40),
    sourceId: String(raw?.sourceId || "").slice(0, 80),
  };
}

// Apply one movement to a product already loaded from the database.
// Other stores' quantities and IMEIs are copied through.
function applyStockMovement(product, movement) {
  const requiresImei = Boolean(product?.requiresImei);
  const map = stockMapOf(product);
  const location = movement.location;
  const before = JSON.stringify(map);
  let shortQty = 0;
  const missingImeis = [];

  const byImei = movement.op === "removeImeis" || movement.op === "addImeis";
  const byCount = movement.op === "removeQty" || movement.op === "addQty";
  if ((requiresImei && byCount) || (!requiresImei && byImei)) {
    // The product decides how its stock moves, the same as on the register.
    // A movement of the other kind is recorded and leaves stock alone.
    if (movement.op === "removeQty") shortQty = movement.qty;
    if (movement.op === "removeImeis") missingImeis.push(...movement.imeis);
  } else if (movement.op === "set") {
    const imeis = requiresImei ? movement.imeis : [];
    map[location] = {
      quantity: requiresImei ? imeis.length : movement.qty,
      imeis,
    };
  } else if (movement.op === "addQty" || movement.op === "removeQty") {
    const current = Number(map[location]?.quantity) || 0;
    if (movement.op === "addQty") {
      map[location] = { quantity: current + movement.qty, imeis: [] };
    } else {
      shortQty = Math.max(0, movement.qty - current);
      map[location] = { quantity: Math.max(0, current - movement.qty), imeis: [] };
    }
  } else if (movement.op === "removeImeis" || movement.op === "addImeis") {
    const wanted = new Set(movement.imeis);
    const found = new Set();
    for (const entry of Object.values(map)) {
      for (const imei of cleanImeis(entry.imeis)) {
        if (wanted.has(imei)) found.add(imei);
      }
    }
    for (const imei of movement.imeis) {
      if (!found.has(imei)) missingImeis.push(imei);
    }
    for (const [store, entry] of Object.entries(map)) {
      const kept = cleanImeis(entry.imeis).filter((imei) => !wanted.has(imei));
      map[store] = { quantity: kept.length, imeis: kept };
    }
    if (movement.op === "addImeis") {
      const here = cleanImeis([...(map[location]?.imeis || []), ...movement.imeis]);
      map[location] = { quantity: here.length, imeis: here };
    }
  }

  const stock = {};
  for (const [store, entry] of Object.entries(map)) {
    const imeis = requiresImei ? cleanImeis(entry.imeis) : [];
    stock[store] = {
      quantity: requiresImei ? imeis.length : Math.max(0, Number(entry.quantity) || 0),
      imeis,
    };
  }
  const imeis = requiresImei ? cleanImeis(Object.values(stock).flatMap((entry) => entry.imeis)) : [];
  const quantity = requiresImei
    ? imeis.length
    : Object.values(stock).reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0);
  const changedLocations = Object.keys(stock).filter((store) => JSON.stringify(stock[store]) !== JSON.stringify(JSON.parse(before)[store] || null));
  if (movement.op === "set" && !changedLocations.includes(location)) changedLocations.push(location);

  return {
    product: { ...product, stock, imeis, quantity, location: "" },
    shortQty,
    missingImeis,
    locations: [...new Set(changedLocations)],
    changed: before !== JSON.stringify(stock),
  };
}

// Fold a batch onto fresh products. A movement id already in `appliedIds` is skipped.
function planStockCommit(productsById, appliedIds, movements) {
  const working = new Map(Object.entries(productsById).map(([id, product]) => [id, product]));
  const applied = [];
  const skipped = [];
  for (const raw of movements) {
    const movement = normalizeMovement(raw);
    if (!movement) continue;
    if (appliedIds.has(movement.id)) {
      skipped.push(movement.id);
      continue;
    }
    const product = working.get(movement.productId);
    if (!product) {
      const error = new Error(`Product ${movement.productId} is not in inventory yet.`);
      error.code = "not-found";
      throw error;
    }
    const next = applyStockMovement(product, movement);
    working.set(movement.productId, next.product);
    applied.push({ movement, result: next });
    appliedIds.add(movement.id);
  }
  return {
    products: Object.fromEntries(working),
    applied,
    skipped,
  };
}

module.exports = {
  stockMapOf,
  applyStockMovement,
  normalizeMovement,
  planStockCommit,
};
