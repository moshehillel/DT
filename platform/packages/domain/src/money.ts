/**
 * Money is always an integer number of minor units (cents). Floats never hold
 * money: the old app summed `Number("12.10")` style values and rounded at the
 * end, which drifts by a cent on long carts and split tenders.
 */
export type Cents = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of cents, got ${value}`);
  }
  return value;
}

export function assertNonNegativeCents(value: number, label = "amount"): Cents {
  assertCents(value, label);
  if (value < 0) throw new MoneyError(`${label} must not be negative`);
  return value;
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d{0,2}))?$/;

/**
 * Parse a human/legacy money string ("12", "12.5", "$1,234.56", "-3.10") into
 * cents without ever going through a float. Returns null for anything that is
 * not an unambiguous amount (including more than two decimals).
 */
export function parseMoney(input: unknown): Cents | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    // Legacy documents stored floats; round half away from zero at 2dp via string.
    return parseMoney(input.toFixed(2));
  }
  if (typeof input !== "string") return null;
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const match = DECIMAL_RE.exec(cleaned);
  if (!match) return null;
  const [, sign, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return sign === "-" ? -cents : cents;
}

export function toDecimalString(cents: Cents): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export function formatMoney(cents: Cents, currency = "USD", locale = "en-US"): string {
  assertCents(cents);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total += assertCents(value);
  return assertCents(total, "sum");
}

/** Integer division rounding half away from zero. */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0 || !Number.isSafeInteger(denominator)) {
    throw new MoneyError("denominator must be a positive integer");
  }
  if (!Number.isSafeInteger(numerator)) throw new MoneyError("numerator must be a safe integer");
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const quotient = Math.floor(abs / denominator);
  const remainder = abs - quotient * denominator;
  return sign * (remainder * 2 >= denominator ? quotient + 1 : quotient);
}

/** cents × (num / den), rounded half up. Uses BigInt so large carts never overflow. */
export function mulRatio(cents: Cents, num: number, den: number): Cents {
  assertCents(cents);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    throw new MoneyError("ratio must be integers with a positive denominator");
  }
  const product = BigInt(cents) * BigInt(num);
  const bigDen = BigInt(den);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  let quotient = abs / bigDen;
  if ((abs % bigDen) * 2n >= bigDen) quotient += 1n;
  const result = Number(negative ? -quotient : quotient);
  return assertCents(result);
}

/**
 * Split `total` across `weights` so the parts always add back to exactly
 * `total` (largest-remainder method). Used for spreading order-level tax onto
 * lines and for proportional refunds.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total);
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) {
    const parts = weights.map(() => 0);
    parts[0] = total;
    return parts;
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((weight) => (BigInt(abs) * BigInt(Math.max(0, weight))) / BigInt(weightSum));
  const parts = raw.map((value) => Number(value));
  let remaining = abs - parts.reduce((sum, part) => sum + part, 0);
  const order = weights
    .map((weight, index) => ({
      index,
      remainder: Number((BigInt(abs) * BigInt(Math.max(0, weight))) % BigInt(weightSum)),
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    remaining -= 1;
  }
  return parts.map((part) => part * sign);
}
