/**
 * Calendar dates are plain "YYYY-MM-DD" strings in the store's time zone. All
 * arithmetic happens in UTC on those strings so daylight-saving changes can
 * never make a rental one day short (the old app built local Date objects).
 */
export type IsoDate = string;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function toUtcMs(value: IsoDate): number {
  if (!isIsoDate(value)) throw new Error(`invalid date: ${value}`);
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function addDays(value: IsoDate, days: number): IsoDate {
  return new Date(toUtcMs(value) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / 86_400_000);
}

/** Start and end both count: Mon..Mon is 1 day, Mon..Tue is 2. */
export function inclusiveDays(start: IsoDate, end: IsoDate): number {
  const diff = daysBetween(start, end);
  return diff >= 0 ? diff + 1 : 0;
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

/** The instant at which a store's wall clock reads `hour:minute` on `date` (DST aware). */
export function zonedTimeToUtc(date: IsoDate, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  let result = naive - zoneOffsetMs(new Date(naive), timeZone);
  result = naive - zoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

/** Today's calendar date in an IANA time zone (the store's), from a server clock. */
export function isoDateInZone(instant: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
