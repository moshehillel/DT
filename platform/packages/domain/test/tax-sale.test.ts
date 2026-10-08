import { describe, expect, it } from "vitest";
import { planTenders, parsePriceAdjust, priceSale } from "../src/sale.js";
import { computeTax, DEFAULT_TAX_RULES, percentToPpm, ppmToPercentString, proportionalRefund } from "../src/tax.js";

const NY = { ...DEFAULT_TAX_RULES, ratePpm: percentToPpm("8.875") };

describe("tax engine", () => {
  it("converts percents", () => {
    expect(percentToPpm("8.875")).toBe(88_750);
    expect(percentToPpm(8)).toBe(80_000);
    expect(ppmToPercentString(88_750)).toBe("8.875");
    expect(ppmToPercentString(80_000)).toBe("8");
  });

  it("taxes by item and allocates to lines exactly", () => {
    const result = computeTax(
      [
        { lineId: "a", netCents: 1999 },
        { lineId: "b", netCents: 1001 },
        { lineId: "dep", netCents: 1000, taxCategory: "deposit" },
      ],
      NY,
    );
    expect(result.taxableBaseCents).toBe(3000);
    expect(result.taxCents).toBe(266); // 266.25
    expect(result.lines.reduce((s, l) => s + l.taxCents, 0)).toBe(266);
    expect(result.lines.find((l) => l.lineId === "dep")?.taxCents).toBe(0);
  });

  it("per-line rounding is supported as a tenant option", () => {
    const result = computeTax(
      [
        { lineId: "a", netCents: 105 },
        { lineId: "b", netCents: 105 },
      ],
      { ...NY, rounding: "per_line" },
    );
    expect(result.taxCents).toBe(18); // 9 + 9 (9.32 each) vs per-order 18.64 -> 19
  });

  it("out of state is exempt and flagged", () => {
    const result = computeTax([{ lineId: "a", netCents: 1000 }], NY, { outOfState: true });
    expect(result.taxCents).toBe(0);
    expect(result.flags).toContain("OUT_OF_STATE_EXEMPT");
  });

  it("default mode ignores how the sale was paid", () => {
    const result = computeTax([{ lineId: "a", netCents: 10000 }], NY, { legacyCashShareCents: 4000 });
    expect(result.taxCents).toBe(888);
    expect(result.flags).toHaveLength(0);
  });

  it("legacy mode reproduces the old split-cash rule and flags it", () => {
    const result = computeTax([{ lineId: "a", netCents: 10000 }], { ...NY, mode: "legacy_split_cash_exempt" }, {
      legacyCashShareCents: 4000,
    });
    expect(result.taxableBaseCents).toBe(6000);
    expect(result.taxCents).toBe(533); // 532.5
    expect(result.flags).toContain("LEGACY_SPLIT_CASH_EXEMPTION_USED");
  });

  it("partial returns never over-refund", () => {
    const first = proportionalRefund({ originalCents: 100, originalQty: 3, alreadyReturnedQty: 0, alreadyRefundedCents: 0, returnQty: 1 });
    const second = proportionalRefund({ originalCents: 100, originalQty: 3, alreadyReturnedQty: 1, alreadyRefundedCents: first, returnQty: 1 });
    const third = proportionalRefund({
      originalCents: 100,
      originalQty: 3,
      alreadyReturnedQty: 2,
      alreadyRefundedCents: first + second,
      returnQty: 1,
    });
    expect(first + second + third).toBe(100);
    expect(() =>
      proportionalRefund({ originalCents: 100, originalQty: 3, alreadyReturnedQty: 3, alreadyRefundedCents: 100, returnQty: 1 }),
    ).toThrow();
  });
});

describe("sale pricing and tenders", () => {
  it("applies price-adjust codes and never goes negative", () => {
    expect(parsePriceAdjust("+35")).toBe(3500);
    expect(parsePriceAdjust("-10")).toBe(-1000);
    expect(parsePriceAdjust("35")).toBe(3500);
    expect(parsePriceAdjust("abc")).toBe(0);
    const totals = priceSale(
      [
        { lineId: "1", unitPriceCents: 1000, qty: 2, adjustCents: -1500 },
        { lineId: "2", unitPriceCents: 2500, qty: 1 },
      ],
      NY,
    );
    expect(totals.lines[0]?.netCents).toBe(0);
    expect(totals.subtotalCents).toBe(2500);
    expect(totals.taxCents).toBe(222);
    expect(totals.totalCents).toBe(2722);
  });

  it("requires tenders to match the total", () => {
    expect(planTenders({ totalCents: 1000, tenders: [{ method: "cash", amountCents: 1000 }] }).ok).toBe(true);
    expect(planTenders({ totalCents: 1000, tenders: [{ method: "cash", amountCents: 900 }] }).issues).toContain(
      "TENDERS_BELOW_TOTAL",
    );
    expect(planTenders({ totalCents: 1000, tenders: [{ method: "cash", amountCents: 1100 }] }).issues).toContain(
      "TENDERS_EXCEED_TOTAL",
    );
  });

  it("split tender with card computes gateway share", () => {
    const plan = planTenders({
      totalCents: 2722,
      tenders: [
        { method: "cash", amountCents: 1000 },
        { method: "card", amountCents: 1722 },
      ],
    });
    expect(plan.ok).toBe(true);
    expect(plan.gatewayCents).toBe(1722);
  });

  it("collect later needs a customer and leaves a balance", () => {
    const customer = { id: "c1", balanceCents: 0, creditLimitCents: 0 };
    const plan = planTenders({ totalCents: 5000, tenders: [], collectLater: { dueDate: "2026-10-20" }, customer });
    expect(plan.ok).toBe(true);
    expect(plan.balanceDueCents).toBe(5000);
    expect(planTenders({ totalCents: 5000, tenders: [], collectLater: { dueDate: "2026-10-20" } }).issues).toContain(
      "COLLECT_LATER_REQUIRES_CUSTOMER",
    );
  });

  it("account tender respects credit and limit", () => {
    const customer = { id: "c1", balanceCents: 1000, creditLimitCents: 500 };
    expect(planTenders({ totalCents: 1500, tenders: [{ method: "account", amountCents: 1500 }], customer }).ok).toBe(true);
    expect(
      planTenders({ totalCents: 1600, tenders: [{ method: "account", amountCents: 1600 }], customer }).issues,
    ).toContain("ACCOUNT_OVER_LIMIT");
  });
});
