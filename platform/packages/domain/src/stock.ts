/**
 * Stock is an append-only ledger of movements; a store's on-hand quantity is
 * the running sum, cached in inventory_balances and updated in the same
 * transaction as the movement. Serialized handsets (IMEI) are additionally
 * tracked one row per physical unit.
 */
export const MOVEMENT_KINDS = [
  "receive",
  "sale",
  "return",
  "transfer_out",
  "transfer_in",
  "adjust",
  "count",
  "rental_out",
  "rental_in",
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const ADJUST_REASONS = ["damaged", "lost", "theft", "found", "correction", "rma", "internal_use"] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export class StockRuleError extends Error {
  constructor(
    public readonly code:
      | "INSUFFICIENT_STOCK"
      | "INVALID_QTY"
      | "REASON_REQUIRED"
      | "INVALID_TRANSITION"
      | "INVALID_IMEI"
      | "SAME_STORE_TRANSFER",
    message: string,
  ) {
    super(message);
    this.name = "StockRuleError";
  }
}

/** Signed quantity change a movement applies to the store's balance. */
export function movementDelta(kind: MovementKind, qty: number, countedFrom?: number): number {
  if (kind === "count") {
    if (countedFrom === undefined) throw new StockRuleError("INVALID_QTY", "count needs the current on-hand");
    if (!Number.isInteger(qty) || qty < 0) throw new StockRuleError("INVALID_QTY", "counted qty must be >= 0");
    return qty - countedFrom;
  }
  if (kind === "adjust") {
    if (!Number.isInteger(qty) || qty === 0) throw new StockRuleError("INVALID_QTY", "adjust qty must be non-zero");
    return qty;
  }
  if (!Number.isInteger(qty) || qty <= 0) throw new StockRuleError("INVALID_QTY", "qty must be a positive integer");
  switch (kind) {
    case "receive":
    case "return":
    case "transfer_in":
    case "rental_in":
      return qty;
    case "sale":
    case "transfer_out":
    case "rental_out":
      return -qty;
  }
}

export interface StockPolicy {
  allowNegative: boolean;
}

export function applyToBalance(
  onHand: number,
  kind: MovementKind,
  qty: number,
  policy: StockPolicy,
  reason?: string | null,
): { delta: number; after: number } {
  if (kind === "adjust" && !reason) throw new StockRuleError("REASON_REQUIRED", "an adjustment needs a reason");
  const delta = movementDelta(kind, qty, onHand);
  const after = onHand + delta;
  if (after < 0 && !policy.allowNegative && kind !== "count") {
    throw new StockRuleError("INSUFFICIENT_STOCK", `only ${onHand} on hand`);
  }
  return { delta, after };
}

export const UNIT_STATUSES = ["in_stock", "sold", "rma", "rental_fleet", "in_transit", "written_off"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

const UNIT_TRANSITIONS: Record<UnitStatus, readonly UnitStatus[]> = {
  in_stock: ["sold", "rma", "rental_fleet", "in_transit", "written_off"],
  sold: ["in_stock", "rma"],
  rma: ["in_stock", "written_off"],
  rental_fleet: ["in_stock", "written_off"],
  in_transit: ["in_stock"],
  written_off: [],
};

export function assertUnitTransition(from: UnitStatus, to: UnitStatus): void {
  if (!UNIT_TRANSITIONS[from].includes(to)) {
    throw new StockRuleError("INVALID_TRANSITION", `a unit that is ${from} cannot become ${to}`);
  }
}

/** Digits only; 14–17 digits accepted (IMEI, IMEISV, MEID-dec). */
export function normalizeImei(value: string): string {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 14 || digits.length > 17) {
    throw new StockRuleError("INVALID_IMEI", `"${value}" is not an IMEI`);
  }
  return digits;
}

/** Luhn check for 15-digit IMEIs. A failed check is a warning, not a block — some handsets ship odd ones. */
export function imeiChecksumOk(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    let digit = Number(imei[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function planTransfer(fromStoreId: string, toStoreId: string, qty: number) {
  if (fromStoreId === toStoreId) throw new StockRuleError("SAME_STORE_TRANSFER", "pick two different stores");
  if (!Number.isInteger(qty) || qty <= 0) throw new StockRuleError("INVALID_QTY", "qty must be a positive integer");
  return [
    { storeId: fromStoreId, kind: "transfer_out" as const, delta: -qty },
    { storeId: toStoreId, kind: "transfer_in" as const, delta: qty },
  ];
}
