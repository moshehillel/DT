import { REGISTER_CALL_TIMEOUT, callFunction } from "./firebaseClient";
import { adjustStoreStock, setStoreStock } from "./utils";

const QUEUE_KEY = "diamant-stock-movement-queue";
// The server takes at most this many stock lines in one call.
const MOVEMENTS_PER_CALL = 50;

function readQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(movements) {
  if (!movements.length) localStorage.removeItem(QUEUE_KEY);
  else localStorage.setItem(QUEUE_KEY, JSON.stringify(movements));
}

export function queueStockMovements(movements) {
  const byId = new Map(readQueue().map((movement) => [movement.id, movement]));
  for (const movement of movements) {
    if (movement?.id) byId.set(movement.id, movement);
  }
  writeQueue([...byId.values()]);
}

function unqueueStockMovements(sent) {
  const ids = new Set(sent.map((movement) => movement.id));
  writeQueue(readQueue().filter((movement) => !ids.has(movement.id)));
}

// One movement per product on a sale, return, or phone order. The id is the
// sale plus the product, so a retry cannot take the units off twice.
export function buildLineMovements({ sourceType, sourceId, location, lines, direction, qtyOf }) {
  const byProduct = new Map();
  for (const line of lines || []) {
    if (!line?.productId || line.isCustom) continue;
    const bucket = byProduct.get(line.productId) || {
      requiresImei: Boolean(line.requiresImei),
      qty: 0,
      imeis: [],
    };
    if (line.requiresImei && line.imei) bucket.imeis.push(String(line.imei).replace(/\D/g, ""));
    else bucket.qty += Math.max(0, Number(qtyOf(line)) || 0);
    byProduct.set(line.productId, bucket);
  }
  const store = String(location || "").trim();
  return [...byProduct.entries()].flatMap(([productId, bucket]) => {
    const imeis = [...new Set(bucket.imeis.filter(Boolean))];
    const op = bucket.requiresImei
      ? (direction === "in" ? "addImeis" : "removeImeis")
      : (direction === "in" ? "addQty" : "removeQty");
    if (op.endsWith("Imeis") && !imeis.length) return [];
    if (op.endsWith("Qty") && bucket.qty <= 0) return [];
    return [{
      id: `${sourceType}:${sourceId}:${productId}`.replace(/[^A-Za-z0-9:_-]/g, "-").slice(0, 180),
      productId,
      location: store,
      op,
      qty: bucket.qty,
      imeis,
      requiresImei: bucket.requiresImei,
      sourceType,
      sourceId,
    }];
  });
}

export function applyMovementLocal(product, movement) {
  if (!product || product.id !== movement.productId) return product;
  if (movement.op === "removeQty") return adjustStoreStock(product, movement.location, { removeQty: movement.qty });
  if (movement.op === "addQty") return adjustStoreStock(product, movement.location, { addQty: movement.qty });
  if (movement.op === "removeImeis") return adjustStoreStock(product, movement.location, { removeImeis: movement.imeis });
  if (movement.op === "addImeis") return adjustStoreStock(product, movement.location, { addImeis: movement.imeis });
  if (movement.op === "set") return setStoreStock(product, movement.location, { quantity: movement.qty, imeis: movement.imeis });
  return product;
}

function sendStockMovements(movements) {
  return callFunction("postStockMovements", { movements }, REGISTER_CALL_TIMEOUT);
}

// The movements are in the queue before the server is asked, and leave it only
// once it has answered. A page closed or reloaded while the server is still
// waking up sends them again from the queue; the ids keep them from applying twice.
const inFlight = new Set();

export async function postStockMovements(movements) {
  const pending = (movements || []).filter((movement) => movement?.id && movement.productId && movement.location);
  if (!pending.length) return { applied: 0, skipped: 0 };
  queueStockMovements(pending);
  pending.forEach((movement) => inFlight.add(movement));
  try {
    const result = await sendStockMovements(pending);
    unqueueStockMovements(pending);
    return result;
  } finally {
    pending.forEach((movement) => inFlight.delete(movement));
  }
}

let retrying = false;

export async function retryQueuedStockMovements() {
  if (retrying) return;
  const sending = new Set([...inFlight].map((movement) => movement.id));
  const queued = readQueue().filter((movement) => !sending.has(movement.id));
  if (!queued.length) return;
  retrying = true;
  try {
    for (let index = 0; index < queued.length; index += MOVEMENTS_PER_CALL) {
      const chunk = queued.slice(index, index + MOVEMENTS_PER_CALL);
      await sendStockMovements(chunk);
      unqueueStockMovements(chunk);
    }
  } catch {
    // Leave the queue. The same ids are safe to send again.
  } finally {
    retrying = false;
  }
}

export function installStockMovementRetry() {
  if (typeof window === "undefined" || window.__diamantStockRetry) return;
  window.__diamantStockRetry = true;
  window.addEventListener("online", () => { retryQueuedStockMovements(); });
  window.setInterval(() => { retryQueuedStockMovements(); }, 20000);
  retryQueuedStockMovements();
}
