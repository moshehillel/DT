import { addDays, daysBetween, inclusiveDays, type IsoDate } from "./dates.js";
import { mulRatio, type Cents } from "./money.js";

/**
 * Rental pricing is a per-tenant price book. Diamant Telecom's current rules
 * (from src/utils.js calculateRentalPrice) are the seeded default:
 *  - Israel / Local: $5 a day
 *  - Canada: $45 per full week, $30 per started 2-day "weekend" of what is left
 *  - everywhere else: $15/day data, $20/day voice+data, +$2/day with SMS
 * Minimum days: Israel 7, Local 1, others 4.
 */
export type RegionPricing =
  | { kind: "flat_daily"; dailyCents: Cents }
  | { kind: "week_weekend"; weekCents: Cents; weekendCents: Cents }
  | { kind: "service_daily"; serviceDailyCents: Record<string, Cents>; smsAddonDailyCents: Cents };

export interface RentalPriceBook {
  regions: Record<string, { pricing: RegionPricing; minimumDays: number }>;
  defaultRegion: { pricing: RegionPricing; minimumDays: number };
  simOnlyDepositCents: Cents;
}

export const DIAMANT_RENTAL_PRICE_BOOK: RentalPriceBook = {
  regions: {
    Israel: { pricing: { kind: "flat_daily", dailyCents: 500 }, minimumDays: 7 },
    Local: { pricing: { kind: "flat_daily", dailyCents: 500 }, minimumDays: 1 },
    Canada: { pricing: { kind: "week_weekend", weekCents: 4500, weekendCents: 3000 }, minimumDays: 4 },
  },
  defaultRegion: {
    pricing: {
      kind: "service_daily",
      serviceDailyCents: { Data: 1500, "Voice and data": 2000 },
      smsAddonDailyCents: 200,
    },
    minimumDays: 4,
  },
  simOnlyDepositCents: 1000,
};

export interface RentalQuoteInput {
  region: string;
  serviceType: string;
  addSms: boolean;
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface RentalQuote {
  totalDays: number;
  minimumDays: number;
  meetsMinimum: boolean;
  totalCents: Cents;
  /** Display-only average; never used to compute a total. */
  averageDailyCents: Cents;
  label: string;
}

function regionRules(book: RentalPriceBook, region: string) {
  return book.regions[region] ?? book.defaultRegion;
}

export function quoteRental(book: RentalPriceBook, input: RentalQuoteInput): RentalQuote {
  const totalDays = inclusiveDays(input.startDate, input.endDate);
  const rules = regionRules(book, input.region);
  const { pricing } = rules;
  let totalCents = 0;
  let label = "";
  if (totalDays > 0) {
    switch (pricing.kind) {
      case "flat_daily":
        totalCents = pricing.dailyCents * totalDays;
        label = "flat daily";
        break;
      case "week_weekend": {
        const weeks = Math.floor(totalDays / 7);
        const weekends = Math.ceil((totalDays % 7) / 2);
        totalCents = weeks * pricing.weekCents + weekends * pricing.weekendCents;
        label = "week + weekend";
        break;
      }
      case "service_daily": {
        const base = pricing.serviceDailyCents[input.serviceType];
        if (base === undefined) throw new Error(`unknown rental service type: ${input.serviceType}`);
        const daily = base + (input.addSms ? pricing.smsAddonDailyCents : 0);
        totalCents = daily * totalDays;
        label = "service daily";
        break;
      }
    }
  }
  return {
    totalDays,
    minimumDays: rules.minimumDays,
    meetsMinimum: totalDays >= rules.minimumDays,
    totalCents,
    averageDailyCents: totalDays ? mulRatio(totalCents, 1, totalDays) : 0,
    label,
  };
}

export function returnDueDate(endDate: IsoDate, graceDays: number): IsoDate {
  return addDays(endDate, Math.max(0, Math.trunc(graceDays)));
}

/**
 * Late fee accrued at an agreed weekly rate, prorated per day, rounded once at
 * the end (weekly × days / 7). Matches calculateRentalLateFee in the old app
 * except it can never produce fractional cents.
 */
export function rentalLateFee(params: { dueDate: IsoDate; asOf: IsoDate; weeklyFeeCents: Cents }): {
  daysLate: number;
  amountCents: Cents;
} {
  const daysLate = Math.max(0, daysBetween(params.dueDate, params.asOf));
  return {
    daysLate,
    amountCents: params.weeklyFeeCents > 0 ? mulRatio(params.weeklyFeeCents, daysLate, 7) : 0,
  };
}

/** RCUK allocates numbers about this many days before the trip starts. */
export const RENTAL_NUMBER_LEAD_DAYS = 5;

export function rentalNumbersDueDate(startDate: IsoDate): IsoDate {
  return addDays(startDate, -RENTAL_NUMBER_LEAD_DAYS);
}

/** SIM ICCID helpers (RCUK stocks: Vodafone 00030… under 89441, O2 006… under 894411). */
export const RCUK_SIM_CARRIERS = [
  { carrier: "Vodafone", entryPrefix: "00030", fullPrefix: "89441", fullLength: 20 },
  { carrier: "O2", entryPrefix: "006", fullPrefix: "894411", fullLength: 19 },
] as const;

export function normalizeRcukSimNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("8944100030") || digits.startsWith("894411006")) return digits;
  if (digits.startsWith("00030")) return `89441${digits}`;
  if (digits.startsWith("006")) return `894411${digits}`;
  return digits;
}

export function rcukSimEntry(value: string) {
  const normalized = normalizeRcukSimNumber(value);
  const match = RCUK_SIM_CARRIERS.find((entry) => normalized.startsWith(entry.fullPrefix + entry.entryPrefix));
  return {
    normalized,
    carrier: match?.carrier ?? "",
    fullLength: match?.fullLength ?? 0,
    recognized: Boolean(match),
    complete: Boolean(match) && normalized.length === match?.fullLength,
    tooLong: Boolean(match) && normalized.length > (match?.fullLength ?? 0),
  };
}
