import { reportTypes } from "./constants";

export function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

export function createEmptyFilters() {
  return {
    query: "",
    type: "all",
    employee: "all",
    status: "all",
    paymentMethod: "all",
    dateFrom: "",
    dateTo: "",
    amountMin: "",
    amountMax: "",
  };
}

export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
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
        reportTypes[report.type].label,
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
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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
    const dateDiff = new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0);
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

      return {
        id: `rental-overdue-${report.id}`,
        severity: "urgent",
        title: "Rental past due",
        message: `${report.customerPhone || "Customer"} should have returned ${report.details?.model || report.details?.rentalType || "rental"} by ${dueDate}.`,
      };
    })
    .filter(Boolean);
}
