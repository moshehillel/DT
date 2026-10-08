import { describe, expect, it } from "vitest";
import { allocate, divRoundHalfUp, formatMoney, mulRatio, parseMoney, sumCents, toDecimalString } from "../src/money.js";

describe("money", () => {
  it("parses legacy strings without floats", () => {
    expect(parseMoney("12")).toBe(1200);
    expect(parseMoney("12.5")).toBe(1250);
    expect(parseMoney("$1,234.56")).toBe(123456);
    expect(parseMoney("-3.10")).toBe(-310);
    expect(parseMoney("0.1")).toBe(10);
    expect(parseMoney(0.1 + 0.2)).toBe(30);
    expect(parseMoney("1.234")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });

  it("formats and round-trips", () => {
    expect(toDecimalString(1205)).toBe("12.05");
    expect(toDecimalString(-5)).toBe("-0.05");
    expect(formatMoney(123456)).toBe("$1,234.56");
  });

  it("rounds half away from zero", () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(mulRatio(1000, 88_750, 1_000_000)).toBe(89); // 88.75 -> 89
    expect(mulRatio(100, 1, 3)).toBe(33);
  });

  it("allocates exactly", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(allocate(-10, [3, 1])).toEqual([-8, -2]);
    expect(allocate(7, [0, 0])).toEqual([7, 0]);
  });

  it("rejects fractional cents", () => {
    expect(() => sumCents([1, 2.5])).toThrow();
  });
});
