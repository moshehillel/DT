import { assertCents, assertNonNegativeCents, parseMoney, type Cents } from "./money.js";
import { computeTax, type TaxContext, type TaxResult, type TaxRuleSet } from "./tax.js";

export const TENDER_METHODS = [
  "cash",
  "card",
  "check",
  "zelle",
  "cash_app",
  "apple_pay",
  "other",
  "account",
] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];

/** Methods that must be settled through a payment gateway / terminal (server-verified). */
export function isGatewayTender(method: TenderMethod): boolean {
  return method === "card";
}

/**
 * Per-line price-adjustment code from the till: "+35" adds $35 to the unit
 * price, "-10" takes $10 off, a bare "35" adds. Anything unparseable is no
 * adjustment. Returns cents.
 */
export function parsePriceAdjust(code: string | null | undefined): Cents {
  const clean = String(code ?? "").trim();
  if (!clean) return 0;
  const match = /^([+-]?)(\d+(?:\.\d{1,2})?)$/.exec(clean);
  if (!match) return 0;
  const cents = parseMoney(match[2] ?? "") ?? 0;
  return match[1] === "-" ? -cents : cents;
}

export interface SaleLineInput {
  lineId: string;
  unitPriceCents: Cents;
  qty: number;
  adjustCents?: Cents;
  taxCategory?: string | null;
  taxable?: boolean;
}

export interface PricedLine extends SaleLineInput {
  effectiveUnitCents: Cents;
  netCents: Cents;
  taxCents: Cents;
}

export interface SaleTotals {
  lines: PricedLine[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  tax: TaxResult;
}

/** A discount can bring an item to $0 but never make the shop owe money for it. */
export function effectiveUnitPrice(unitPriceCents: Cents, adjustCents = 0): Cents {
  return Math.max(0, assertCents(unitPriceCents) + assertCents(adjustCents));
}

export function priceSale(lines: readonly SaleLineInput[], rules: TaxRuleSet, context: TaxContext = {}): SaleTotals {
  const priced = lines.map((line) => {
    if (!Number.isInteger(line.qty) || line.qty <= 0) throw new Error(`line ${line.lineId}: qty must be a positive integer`);
    assertNonNegativeCents(line.unitPriceCents, `line ${line.lineId} price`);
    const effectiveUnitCents = effectiveUnitPrice(line.unitPriceCents, line.adjustCents ?? 0);
    return { ...line, effectiveUnitCents, netCents: effectiveUnitCents * line.qty, taxCents: 0 };
  });
  const tax = computeTax(
    priced.map((line) => ({
      lineId: line.lineId,
      netCents: line.netCents,
      taxCategory: line.taxCategory ?? null,
      ...(line.taxable === undefined ? {} : { taxable: line.taxable }),
    })),
    rules,
    context,
  );
  const taxByLine = new Map(tax.lines.map((entry) => [entry.lineId, entry.taxCents]));
  const withTax = priced.map((line) => ({ ...line, taxCents: taxByLine.get(line.lineId) ?? 0 }));
  const subtotalCents = withTax.reduce((sum, line) => sum + line.netCents, 0);
  return {
    lines: withTax,
    subtotalCents,
    taxCents: tax.taxCents,
    totalCents: subtotalCents + tax.taxCents,
    tax,
  };
}

export interface TenderInput {
  method: TenderMethod;
  amountCents: Cents;
}

export type TenderIssue =
  | "NO_TENDERS"
  | "NEGATIVE_TENDER"
  | "TENDERS_EXCEED_TOTAL"
  | "TENDERS_BELOW_TOTAL"
  | "DUPLICATE_METHOD"
  | "ACCOUNT_REQUIRES_CUSTOMER"
  | "ACCOUNT_OVER_LIMIT"
  | "COLLECT_LATER_REQUIRES_CUSTOMER"
  | "COLLECT_LATER_REQUIRES_DUE_DATE";

export interface TenderPlanInput {
  totalCents: Cents;
  tenders: readonly TenderInput[];
  collectLater?: { dueDate: string } | null;
  customer?: { id: string; balanceCents: Cents; creditLimitCents: Cents } | null;
}

export interface TenderPlan {
  ok: boolean;
  issues: TenderIssue[];
  paidNowCents: Cents;
  balanceDueCents: Cents;
  gatewayCents: Cents;
  accountCents: Cents;
}

/**
 * Checks how a sale is being paid. Tenders must add up to the total exactly
 * (cash change is handled at the till and never recorded as revenue), unless
 * the sale is "collect later", in which case anything not tendered now is a
 * balance due on the order with a due date and a reminder.
 *
 * Customer balance convention: positive = credit the shop holds for the
 * customer, negative = the customer owes the shop. Paying "on account" may draw
 * the balance down to -creditLimit.
 */
export function planTenders(input: TenderPlanInput): TenderPlan {
  const issues: TenderIssue[] = [];
  const seen = new Set<TenderMethod>();
  let paid = 0;
  let gateway = 0;
  let account = 0;
  for (const tender of input.tenders) {
    if (!Number.isSafeInteger(tender.amountCents) || tender.amountCents <= 0) issues.push("NEGATIVE_TENDER");
    if (seen.has(tender.method)) issues.push("DUPLICATE_METHOD");
    seen.add(tender.method);
    paid += tender.amountCents;
    if (isGatewayTender(tender.method)) gateway += tender.amountCents;
    if (tender.method === "account") account += tender.amountCents;
  }

  if (account > 0) {
    if (!input.customer) issues.push("ACCOUNT_REQUIRES_CUSTOMER");
    else if (input.customer.balanceCents - account < -input.customer.creditLimitCents) issues.push("ACCOUNT_OVER_LIMIT");
  }

  if (paid > input.totalCents) issues.push("TENDERS_EXCEED_TOTAL");
  if (input.collectLater) {
    if (!input.customer) issues.push("COLLECT_LATER_REQUIRES_CUSTOMER");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.collectLater.dueDate)) issues.push("COLLECT_LATER_REQUIRES_DUE_DATE");
  } else {
    if (input.totalCents > 0 && input.tenders.length === 0) issues.push("NO_TENDERS");
    else if (paid < input.totalCents) issues.push("TENDERS_BELOW_TOTAL");
  }

  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    paidNowCents: paid,
    balanceDueCents: Math.max(0, input.totalCents - paid),
    gatewayCents: gateway,
    accountCents: account,
  };
}
