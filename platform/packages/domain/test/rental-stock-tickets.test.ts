import { describe, expect, it } from "vitest";
import { addDays, inclusiveDays, isIsoDate, zonedTimeToUtc } from "../src/dates.js";
import { DIAMANT_RENTAL_PRICE_BOOK, quoteRental, rcukSimEntry, rentalLateFee, returnDueDate } from "../src/rental.js";
import { canTransition, legacyStatusToWorkOrderStatus, parseRepairPrice, readyNotificationPlan, repairTotals } from "../src/repair.js";
import { applyToBalance, assertUnitTransition, imeiChecksumOk, normalizeImei, planTransfer, StockRuleError } from "../src/stock.js";
import { legacyTicketAliases, parseTicketInput, planBlock, takeFromBlock, TICKET_FIRST } from "../src/tickets.js";
import { normalizeUsPhone, renderTemplate, staffInitials, titleCaseName } from "../src/text.js";

describe("dates", () => {
  it("is DST safe", () => {
    expect(inclusiveDays("2026-03-07", "2026-03-09")).toBe(3);
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(isIsoDate("2026-02-30")).toBe(false);
  });
  it("converts store wall-clock time to UTC across DST", () => {
    expect(zonedTimeToUtc("2026-07-01", 10, 0, "America/New_York").toISOString()).toBe("2026-07-01T14:00:00.000Z");
    expect(zonedTimeToUtc("2026-12-01", 10, 0, "America/New_York").toISOString()).toBe("2026-12-01T15:00:00.000Z");
  });
});

describe("rental pricing (ported from calculateRentalPrice)", () => {
  const book = DIAMANT_RENTAL_PRICE_BOOK;
  it("Israel is $5/day with a 7 day minimum", () => {
    const q = quoteRental(book, { region: "Israel", serviceType: "Data", addSms: false, startDate: "2026-10-01", endDate: "2026-10-05" });
    expect(q.totalDays).toBe(5);
    expect(q.totalCents).toBe(2500);
    expect(q.meetsMinimum).toBe(false);
  });
  it("Canada is $45/week + $30 per started weekend", () => {
    const q = quoteRental(book, { region: "Canada", serviceType: "Data", addSms: false, startDate: "2026-10-01", endDate: "2026-10-10" });
    expect(q.totalDays).toBe(10);
    expect(q.totalCents).toBe(4500 + 2 * 3000);
  });
  it("UK voice+data with SMS is $22/day", () => {
    const q = quoteRental(book, { region: "UK", serviceType: "Voice and data", addSms: true, startDate: "2026-10-01", endDate: "2026-10-08" });
    expect(q.totalCents).toBe(8 * 2200);
  });
  it("late fee prorates the weekly rate", () => {
    const due = returnDueDate("2026-10-08", 2);
    expect(due).toBe("2026-10-10");
    expect(rentalLateFee({ dueDate: due, asOf: "2026-10-13", weeklyFeeCents: 3500 })).toEqual({ daysLate: 3, amountCents: 1500 });
    expect(rentalLateFee({ dueDate: due, asOf: "2026-10-09", weeklyFeeCents: 3500 }).amountCents).toBe(0);
  });
  it("recognises RCUK SIMs", () => {
    expect(rcukSimEntry("006123456789012").normalized.startsWith("894411006")).toBe(true);
    expect(rcukSimEntry("000301234567890").carrier).toBe("Vodafone");
  });
});

describe("stock rules", () => {
  it("blocks overselling unless the tenant allows negative stock", () => {
    expect(applyToBalance(2, "sale", 2, { allowNegative: false }).after).toBe(0);
    expect(() => applyToBalance(1, "sale", 2, { allowNegative: false })).toThrow(StockRuleError);
    expect(applyToBalance(1, "sale", 2, { allowNegative: true }).after).toBe(-1);
  });
  it("count sets the balance and adjust needs a reason", () => {
    expect(applyToBalance(7, "count", 4, { allowNegative: false })).toEqual({ delta: -3, after: 4 });
    expect(() => applyToBalance(7, "adjust", -1, { allowNegative: false })).toThrow(/reason/);
    expect(applyToBalance(7, "adjust", -1, { allowNegative: false }, "damaged").after).toBe(6);
  });
  it("serialized unit transitions", () => {
    expect(() => assertUnitTransition("in_stock", "sold")).not.toThrow();
    expect(() => assertUnitTransition("sold", "sold")).toThrow();
    expect(() => assertUnitTransition("written_off", "in_stock")).toThrow();
  });
  it("IMEI helpers", () => {
    expect(normalizeImei("35-209900-176148-1")).toBe("352099001761481");
    expect(imeiChecksumOk("352099001761481")).toBe(true);
    expect(() => normalizeImei("123")).toThrow();
  });
  it("transfers are two balanced movements", () => {
    const moves = planTransfer("a", "b", 3);
    expect(moves.reduce((s, m) => s + m.delta, 0)).toBe(0);
    expect(() => planTransfer("a", "a", 1)).toThrow();
  });
});

describe("ticket numbers", () => {
  it("issues blocks from the counter", () => {
    const { block, counterNext } = planBlock(0, 3);
    expect(block.start).toBe(TICKET_FIRST);
    expect(counterNext).toBe(TICKET_FIRST + 3);
    let current = block;
    const issued: number[] = [];
    for (;;) {
      const next = takeFromBlock(current);
      if (!next) break;
      issued.push(next.ticket);
      current = next.block;
    }
    expect(issued).toEqual([100001, 100002, 100003]);
    expect(() => planBlock(999_999, 2)).toThrow(/exhausted/);
  });
  it("parses IVR input and keeps legacy aliases", () => {
    expect(parseTicketInput("#100 234")).toBe(100234);
    expect(parseTicketInput("12345")).toBeNull();
    expect(legacyTicketAliases({ details: { ticketNumber: "100200", ticketNumberWas: "100150" } })).toEqual(["100200", "100150"]);
  });
});

describe("repairs", () => {
  it("statuses", () => {
    expect(canTransition("received", "ready")).toBe(true);
    expect(canTransition("picked_up", "ready")).toBe(false);
    expect(canTransition("picked_up", "ready", { allowReopen: true })).toBe(true);
    expect(legacyStatusToWorkOrderStatus("Completed")).toBe("picked_up");
    expect(legacyStatusToWorkOrderStatus("Waiting for parts")).toBe("waiting_for_parts");
  });
  it("totals and price sheet", () => {
    expect(repairTotals({ estimateCents: 9000, fixes: [{ description: "port", priceCents: 3500 }] }).totalCents).toBe(12500);
    expect(parseRepairPrice("$350.00")).toEqual({ kind: "fixed", cents: 35000 });
    expect(parseRepairPrice("80/90")).toEqual({ kind: "range", lowCents: 8000, highCents: 9000 });
    expect(parseRepairPrice("NA")).toEqual({ kind: "na" });
  });
  it("ready text scheduling", () => {
    const now = new Date("2026-10-07T20:00:00Z");
    expect(readyNotificationPlan(now, null).scheduled).toBe(false);
    expect(readyNotificationPlan(now, new Date("2026-10-07T20:00:10Z")).scheduled).toBe(false);
    expect(readyNotificationPlan(now, new Date("2026-10-08T14:00:00Z")).scheduled).toBe(true);
  });
});

describe("text", () => {
  it("phones, names, templates", () => {
    expect(normalizeUsPhone("1 (347) 388-7467")).toBe("+13473887467");
    expect(normalizeUsPhone("388-7467")).toBeNull();
    expect(titleCaseName("o'brien anne-marie")).toBe("O'Brien Anne-Marie");
    expect(staffInitials("Moshe Glick")).toBe("M.G.");
    expect(renderTemplate("Hi {{name}}, ticket {{ticket}}", { name: "Avi" })).toEqual({ text: "Hi Avi, ticket", missing: ["ticket"] });
  });
});
