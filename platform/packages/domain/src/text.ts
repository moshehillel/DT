export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * US numbers are stored as E.164 (+1XXXXXXXXXX). A leading country-code "1"
 * is stripped first because NANP local numbers never start with 1. Returns
 * null for anything that is not a complete number — customers are unique per
 * tenant by this value, so a half-typed number must never create a record.
 */
export function normalizeUsPhone(value: unknown): string | null {
  let digits = digitsOnly(value);
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10 || digits.startsWith("0") || digits.startsWith("1")) return null;
  return `+1${digits}`;
}

/** 8456370687 -> "845 637 0687" for thermal receipts. */
export function formatReceiptPhone(value: unknown): string {
  const e164 = normalizeUsPhone(value);
  if (!e164) return String(value ?? "").trim();
  const d = e164.slice(2);
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** "moshe gluck" -> "Moshe Gluck", "o'brien" -> "O'Brien". */
export function titleCaseName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z])/g, (_match, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Customer-facing paperwork names staff by initials only. */
export function staffInitials(name: unknown): string {
  return String(name ?? "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}.`)
    .join("");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Tiny, safe template renderer for SMS/email bodies: `{{name}}` only, no
 * logic, unknown variables are reported rather than silently left blank.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      missing.push(key);
      return "";
    }
    return String(value);
  });
  return { text: text.replace(/[ \t]{2,}/g, " ").trim(), missing };
}
