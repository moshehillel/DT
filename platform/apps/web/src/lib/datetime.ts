const pad = (value: number) => String(value).padStart(2, "0");

/**
 * `<input type="datetime-local">` gives "2026-10-07T18:30" in the register's
 * local time; the API wants an ISO timestamp with an explicit offset.
 */
export function localInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "00"] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(date.getTime())) return null;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function todayIso(addDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + addDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(date);
}
