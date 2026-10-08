import { allocate, assertNonNegativeCents, mulRatio, type Cents } from "./money.js";

/**
 * Tax is data, not code: every tenant/store carries a TaxRuleSet. The default
 * is the conventional "tax by item" rule — what is taxable depends on what was
 * sold, never on how it was paid for.
 *
 * `legacy_split_cash_exempt` reproduces the old app's behaviour (on a split
 * sale where exactly one side is cash, the cash share pays no tax). It is kept
 * only so historical receipts can be recomputed during migration; using it for
 * new sales raises a flag that must be reviewed by the tenant's accountant.
 */
export type TaxMode = "per_item" | "legacy_split_cash_exempt";
export type TaxRounding = "per_order" | "per_line";

export interface TaxRuleSet {
  /** Rate in parts per million of the taxable amount: 8.875% -> 88_750. */
  ratePpm: number;
  mode: TaxMode;
  rounding: TaxRounding;
  /** Product tax categories that are never taxed (e.g. "deposit", "service-exempt"). */
  exemptCategories: readonly string[];
  /** When true, a sale flagged as shipped/out of state pays no tax. */
  outOfStateExempt: boolean;
}

export const DEFAULT_TAX_RULES: TaxRuleSet = {
  ratePpm: 0,
  mode: "per_item",
  rounding: "per_order",
  exemptCategories: ["deposit", "account_payment"],
  outOfStateExempt: true,
};

export interface TaxableLine {
  lineId: string;
  /** Net line amount after price adjustments, before tax. */
  netCents: Cents;
  taxCategory?: string | null;
  /** Explicit override (e.g. a custom line marked non-taxable). */
  taxable?: boolean;
}

export interface TaxContext {
  outOfState?: boolean;
  /** Only read by legacy mode: the cash side's share of the pre-tax subtotal on a cash/non-cash split. */
  legacyCashShareCents?: Cents;
}

export type TaxFlag = "LEGACY_SPLIT_CASH_EXEMPTION_USED" | "OUT_OF_STATE_EXEMPT";

export interface TaxResult {
  ratePpm: number;
  taxableBaseCents: Cents;
  taxCents: Cents;
  lines: { lineId: string; taxableCents: Cents; taxCents: Cents }[];
  flags: TaxFlag[];
}

export function percentToPpm(percent: number | string): number {
  const text = String(percent).trim();
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw new Error(`invalid tax percent: ${percent}`);
  const [, whole, frac = ""] = match;
  return Number(whole) * 10_000 + Number(frac.padEnd(4, "0"));
}

export function ppmToPercentString(ppm: number): string {
  const whole = Math.floor(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function isLineTaxable(line: TaxableLine, rules: TaxRuleSet): boolean {
  if (line.taxable === false) return false;
  if (line.taxCategory && rules.exemptCategories.includes(line.taxCategory)) return false;
  return true;
}

export function computeTax(lines: readonly TaxableLine[], rules: TaxRuleSet, context: TaxContext = {}): TaxResult {
  const flags: TaxFlag[] = [];
  for (const line of lines) assertNonNegativeCents(line.netCents, `line ${line.lineId}`);

  const zero = (): TaxResult => ({
    ratePpm: rules.ratePpm,
    taxableBaseCents: 0,
    taxCents: 0,
    lines: lines.map((line) => ({ lineId: line.lineId, taxableCents: 0, taxCents: 0 })),
    flags,
  });

  if (context.outOfState && rules.outOfStateExempt) {
    flags.push("OUT_OF_STATE_EXEMPT");
    return zero();
  }
  if (rules.ratePpm <= 0) return zero();

  let taxable = lines.map((line) => (isLineTaxable(line, rules) ? line.netCents : 0));

  if (rules.mode === "legacy_split_cash_exempt" && context.legacyCashShareCents) {
    const taxableTotal = taxable.reduce((sum, value) => sum + value, 0);
    const cashShare = Math.min(taxableTotal, Math.max(0, context.legacyCashShareCents));
    const exemptParts = allocate(cashShare, taxable);
    taxable = taxable.map((value, index) => value - (exemptParts[index] ?? 0));
    flags.push("LEGACY_SPLIT_CASH_EXEMPTION_USED");
  }

  const taxableBaseCents = taxable.reduce((sum, value) => sum + value, 0);
  let lineTaxes: Cents[];
  if (rules.rounding === "per_line") {
    lineTaxes = taxable.map((value) => mulRatio(value, rules.ratePpm, 1_000_000));
  } else {
    const orderTax = mulRatio(taxableBaseCents, rules.ratePpm, 1_000_000);
    lineTaxes = allocate(orderTax, taxable);
  }

  return {
    ratePpm: rules.ratePpm,
    taxableBaseCents,
    taxCents: lineTaxes.reduce((sum, value) => sum + value, 0),
    lines: lines.map((line, index) => ({
      lineId: line.lineId,
      taxableCents: taxable[index] ?? 0,
      taxCents: lineTaxes[index] ?? 0,
    })),
    flags,
  };
}

/**
 * The share of an original amount that a partial return gives back. Returning
 * the last remaining units hands back exactly what is left, so a line returned
 * in pieces can never refund a cent more (or less) than was charged.
 */
export function proportionalRefund(params: {
  originalCents: Cents;
  originalQty: number;
  alreadyReturnedQty: number;
  alreadyRefundedCents: Cents;
  returnQty: number;
}): Cents {
  const { originalCents, originalQty, alreadyReturnedQty, alreadyRefundedCents, returnQty } = params;
  if (!Number.isInteger(returnQty) || returnQty <= 0) throw new Error("returnQty must be a positive integer");
  if (alreadyReturnedQty + returnQty > originalQty) throw new Error("cannot return more than was sold");
  if (alreadyReturnedQty + returnQty === originalQty) return originalCents - alreadyRefundedCents;
  return Math.min(originalCents - alreadyRefundedCents, mulRatio(originalCents, returnQty, originalQty));
}
