import { reportTypes } from "./constants";

export function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

// --- Scanner feedback sounds -------------------------------------------------
// Synthesised with the Web Audio API so there's no audio file to ship and it
// works fully offline. A shared AudioContext is created lazily; browsers keep
// it suspended until a user gesture, so we resume() on each play (the scanner's
// Enter keystroke counts as a gesture).
let sharedAudioCtx = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
  return sharedAudioCtx;
}

function playTone({ frequency, duration = 0.12, type = "square", volume = 0.18, slideTo }) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  } catch {
    /* audio is best-effort; never block a scan on it */
  }
}

// Crisp confirmation beep when an item is successfully scanned in.
export function playScanBeep() {
  playTone({ frequency: 880, duration: 0.1, volume: 0.2 });
}

// Lower, descending buzz when a scan doesn't match anything.
export function playScanError() {
  playTone({ frequency: 320, slideTo: 180, duration: 0.28, volume: 0.2 });
}

export function createEmptyFilters() {
  return {
    query: "",
    type: "all",
    employee: "all",
    status: "all",
    paymentMethod: "all",
    location: "all",
    item: "",
    customerName: "",
    dateFrom: "",
    dateTo: "",
    amountMin: "",
    amountMax: "",
  };
}

export function toJsDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeFirestoreValue(value) {
  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value && typeof value === "object" && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000).toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeFirestoreValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeFirestoreValue(item)]),
    );
  }
  return value;
}

export function normalizeFirestoreDoc(id, data) {
  return normalizeFirestoreValue({ id, ...data });
}

export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

// US numbers: strip a leading country-code "1" so entries match the 10-digit
// numbers stored in the CRM. NANP 10-digit numbers never start with 1, so a
// leading 1 is always the country code (incl. the pre-filled "1") — strip one
// even mid-typing so the type-ahead matches from the first local digits.
export function localPhoneDigits(value) {
  const digits = digitsOnly(value);
  return digits.startsWith("1") ? digits.slice(1) : digits;
}

// Title-case a person's name for storage/display: "moshe gluck" -> "Moshe
// Gluck". Capitalizes after spaces, hyphens, and apostrophes (so "o'brien" ->
// "O'Brien", "anne-marie" -> "Anne-Marie") and collapses runs of whitespace.
export function titleCaseName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeRcukSimNumber(value) {
  const digits = digitsOnly(value);
  if (!digits) return "";
  if (digits.startsWith("8944100030") || digits.startsWith("894411006")) return digits;
  if (digits.startsWith("00030")) return `89441${digits}`;
  if (digits.startsWith("006")) return `894411${digits}`;
  return digits;
}

export function generateRepairTicketNumber(reports) {
  const today = new Date();
  const datePart = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  const prefix = `DR-${datePart}`;
  const todaysRepairCount = reports.filter((report) =>
    report.type === "repair" && report.details?.ticketNumber?.startsWith(prefix),
  ).length;

  return `${prefix}-${String(todaysRepairCount + 1).padStart(4, "0")}`;
}

export function exportCsv(reports) {
  const headers = [
    "date",
    "type",
    "ticketNumber",
    "customerPhone",
    "servedBy",
    "paymentAmount",
    "paymentMethod",
    "status",
    "details",
    "notes",
  ];
  const csv = [
    headers.join(","),
    ...reports.map((report) =>
      [
        report.createdAt,
        reportTypes[report.type]?.label ?? report.type,
        report.details?.ticketNumber || "",
        report.customerPhone,
        report.servedBy,
        report.paymentAmount,
        report.paymentMethod,
        report.details?.status || "",
        Object.entries(report.details || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join(" | "),
        report.notes,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `diamant-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value || "").replaceAll('"', '""')}"`;
}

export function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatShortDate(value) {
  const date = toJsDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatPayment(value) {
  const amount = Number.parseFloat(value || "0");
  if (!Number.isFinite(amount) || !value) return "-";
  return formatMoney(amount);
}

export function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function numberValue(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

export function ensureArrayIds(items) {
  return Array.isArray(items)
    ? items.map((item) => {
        if (!item || typeof item !== "object") return item;
        return item.id ? item : { ...item, id: crypto.randomUUID() };
      })
    : [];
}

export function sortCloudItems(items) {
  return [...items].sort((a, b) => {
    const leftDate = toJsDate(b.createdAt || b.updatedAt || b.claimedAt);
    const rightDate = toJsDate(a.createdAt || a.updatedAt || a.claimedAt);
    const dateDiff = (leftDate?.getTime() || 0) - (rightDate?.getTime() || 0);
    if (dateDiff) return dateDiff;
    return String(a.name || a.employee || a.id || "").localeCompare(String(b.name || b.employee || b.id || ""));
  });
}

export function isSameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function calculateInclusiveDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const diff = Math.round((end - start) / 86400000);
  return diff >= 0 ? diff + 1 : 0;
}

export function calculateRentalDailyRate(serviceType, addSms) {
  const base = serviceType === "Voice and data" ? 20 : 15;
  return base + (addSms ? 2 : 0);
}

export function isRentalFormComplete(form) {
  const required = [
    form.rentalRegion,
    form.serviceType,
    form.startDate,
    form.endDate,
    form.deviceKind,
    form.simNumber,
    form.customerPhone,
    form.returnDays,
    form.paymentMethod,
  ];

  if (form.rentalRegion === "RCUK") {
    required.push(form.ukDays, form.euDays, form.wtsDays);
  }

  if (form.deviceKind !== "SIM only") {
    required.push(form.model, form.imei);
  }

  return required.every((value) => String(value ?? "").trim() !== "");
}

export function getMinimumRentalDays(region) {
  if (region === "Israel") return 7;
  return 4;
}

export function calculateRentalPrice(form, totalDays) {
  if (!totalDays) {
    return { dailyRate: 0, totalPrice: 0, label: "-" };
  }

  if (form.rentalRegion === "Israel") {
    return {
      dailyRate: 5,
      totalPrice: totalDays * 5,
      label: "$5/day",
    };
  }

  if (form.rentalRegion === "Canada") {
    const weekCount = Math.floor(totalDays / 7);
    const remainingDays = totalDays % 7;
    const weekendCount = Math.ceil(remainingDays / 2);
    const totalPrice = (weekCount * 45) + (weekendCount * 30);

    return {
      dailyRate: totalDays ? totalPrice / totalDays : 0,
      totalPrice,
      label: "$45/week, $30/weekend",
    };
  }

  const dailyRate = calculateRentalDailyRate(form.serviceType, form.addSms);
  return {
    dailyRate,
    totalPrice: totalDays * dailyRate,
    label: `${formatMoney(dailyRate)}/day`,
  };
}

export function calculateReturnDueDate(endDate, returnDays) {
  if (!endDate) return "";
  const numericDays = numberValue(String(returnDays || "").replace("days", ""));
  const date = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + numericDays);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function isSolaPaidStatus(status) {
  return ["paid", "approved", "captured", "succeeded", "success"].includes(String(status || "").toLowerCase());
}

// Short, human-friendly code printed (and barcoded) on receipts for returns.
export function generateReceiptCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

// Minimal Code128-B barcode renderer (no dependencies). Returns an SVG string
// that scans with a standard 1D laser scanner.
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "233111",
];

export function code128Svg(text, { moduleWidth = 2, height = 60 } = {}) {
  const value = String(text || "");
  if (!value) return "";
  const codes = [104]; // Start Code B
  let checksum = 104;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i) - 32;
    if (code < 0 || code > 94) continue; // skip chars outside Code128-B
    codes.push(code);
    checksum += code * (codes.length - 1);
  }
  codes.push(checksum % 103);
  codes.push(106); // Stop

  let modules = "";
  codes.forEach((code, index) => {
    modules += index === codes.length - 1 ? "2331112" : CODE128_PATTERNS[code];
  });

  let x = 0;
  let rects = "";
  for (let i = 0; i < modules.length; i += 1) {
    const width = Number(modules[i]) * moduleWidth;
    if (i % 2 === 0) {
      rects += `<rect x="${x}" y="0" width="${width}" height="${height}"/>`;
    }
    x += width;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${height}" viewBox="0 0 ${x} ${height}" fill="#000">${rects}</svg>`;
}

export function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function buildAppNotifications(reports) {
  const today = startOfDay(new Date());

  return reports
    .filter((report) => report.type === "rental")
    .map((report) => {
      const dueDate = report.details?.returnDueDate || calculateReturnDueDate(report.details?.endDate, report.details?.returnTime);
      if (!dueDate) return null;
      const due = startOfDay(new Date(`${dueDate}T00:00:00`));
      if (due >= today) return null;

      const daysLate = Math.max(0, Math.round((today - due) / 86400000));
      const weeklyFee = Number(report.details?.lateFeeWeekly) || 0;
      const accruedLateFee = weeklyFee > 0 ? (weeklyFee / 7) * daysLate : 0;
      const device = report.details?.model || report.details?.rentalType || "rental";
      const lateFeePart = accruedLateFee > 0
        ? ` Late fee so far: ${formatMoney(accruedLateFee)} (${daysLate} day${daysLate === 1 ? "" : "s"} × ${formatMoney(weeklyFee / 7)}/day).`
        : "";

      return {
        id: `rental-overdue-${report.id}`,
        severity: "urgent",
        title: "Rental past due",
        message: `${report.customerPhone || "Customer"} should have returned ${device} by ${dueDate}.${lateFeePart}`,
      };
    })
    .filter(Boolean);
}
