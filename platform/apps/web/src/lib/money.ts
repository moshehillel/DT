import { formatMoney, parseMoney, toDecimalString, type Cents } from "@pos/domain";

let currency = "USD";

export function setCurrency(code: string) {
  currency = code || "USD";
}

export function money(cents: Cents): string {
  return formatMoney(cents, currency);
}

/** Parse a staff-typed amount; null when blank or not an unambiguous amount. */
export function parseAmount(text: string): Cents | null {
  if (!text.trim()) return null;
  return parseMoney(text);
}

export function centsToInput(cents: Cents): string {
  return toDecimalString(cents);
}
