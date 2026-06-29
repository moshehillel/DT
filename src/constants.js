export const STORAGE_KEY = "diamant-telecom-reports-v1";
export const PENDING_REPORTS_KEY = "diamant-telecom-pending-reports-v1";
export const PHONE_ORDERS_KEY = "diamant-telecom-phone-orders-v1";
export const ORDER_HANDLERS_KEY = "diamant-telecom-order-handlers-v1";
export const EMPLOYEE_KEY = "diamant-telecom-employees-v1";
export const ACTIVE_EMPLOYEE_KEY = "diamant-telecom-active-employee-v1";
export const RESET_REQUESTS_KEY = "diamant-telecom-reset-requests-v1";
export const PRODUCTS_KEY = "diamant-telecom-products-v1";
export const STORE_LOCATIONS_KEY = "diamant-telecom-store-locations-v1";
export const EMPLOYEE_LOCATIONS_KEY = "diamant-telecom-employee-locations-v1";
export const STORE_DEVICES_KEY = "diamant-telecom-store-devices-v1";
export const STORE_TAX_KEY = "diamant-telecom-store-tax-v1";
export const CUSTOMERS_KEY = "diamant-telecom-customers-v1";
export const FUNCTIONS_BASE_URL = import.meta.env.VITE_FUNCTIONS_BASE_URL || "";

// Company-wide contact details shown on every receipt (same for all stores).
export const COMPANY = {
  phone: "1 (347) 388-7467",
  web: "diamanttelecom.com",
  email: "diamanttelecom@gmail.com",
};

// Per-store address + hours. Matched against the sale's store name by keyword,
// so it works even if the store is named slightly differently in the app.
export const STORE_DETAILS = [
  {
    keywords: ["brooklyn", "bedford"],
    name: "Brooklyn Store",
    address: "803 Bedford Ave Suite 104, Brooklyn, NY 11205",
    phone: "(347) 388-7467",
    hours: "Sun 12PM-6:30PM · Mon-Thu 10:30AM-6:30PM",
  },
  {
    keywords: ["upstate", "monroe", "maglenitz"],
    name: "Upstate Store",
    address: "1 Maglenitz St #001, Monroe, NY 10950",
    phone: "(347) 388-7467",
    hours: "Sun 12PM-6:30PM · Mon-Thu 10:30AM-6:30PM",
  },
  {
    keywords: ["catskill", "monticello", "broadway", "home square"],
    name: "Catskills Store",
    address: "Home Square — 335 E Broadway, Monticello, NY 12701",
    phone: "(845) 685-6000",
    hours: "",
  },
];

export function resolveStoreDetails(location) {
  const text = String(location || "").toLowerCase();
  if (!text) return null;
  return STORE_DETAILS.find((store) => store.keywords.some((keyword) => text.includes(keyword))) || null;
}

export const defaultEmployees = [];
export const defaultOrderHandlers = [
  { id: "handler-default", name: "Moshe", phone: "", location: "Main store" },
];
export const defaultStoreLocations = ["Main store"];
export const productCategories = ["Phone", "Accessory", "SIM", "Other"];
export const paymentMethods = ["Cash", "CC", "Card", "Check", "Zelle", "Cash App", "Apple Pay", "Other"];
export const repairStatuses = [
  "Received",
  "Diagnosing",
  "Waiting for parts",
  "In repair",
  "Ready",
  "Picked up",
  "Completed",
  "Cancelled",
];

// Common repair phone models, surfaced as autocomplete suggestions on the
// repair form. The field still accepts any custom value the employee types.
export const repairPhoneModels = [
  "LG Exalt VN220",
  "LG Classic Flip",
  "Kyocera E4610",
  "Kyocera E4810",
  "Kyocera S2720",
  "Qin F30",
  "TCL Flip 2",
  "Alcatel 4051S",
  "POM TX 10",
  "Pom Classic",
  "FIG Flip 2 (F52)",
  "FIG Mini (F45)",
  "Coolpad",
  "Nokia 6300",
  "ANS F30",
  "Sunbeam",
  "XP3 3800",
  "XP3+ 3900",
  "Etalk",
];

// Repair/service types taken from the shop price sheet. Surfaced as autocomplete
// suggestions on the repair form's damage field; the field still accepts any
// custom value the employee types and can be edited after selecting one.
export const repairDamageTypes = [
  "ShellChange",
  "Upper Hinge",
  "Bottom Hinge",
  "Flex Cable",
  "Hinge + Cable",
  "Screen Replacments",
  "Upper Green Board",
  "Charge Port",
  "Mic",
  "Speaker Mic",
  "BothMics",
  "Loud Speaker",
  "EarPeice",
  "Earphone Jack",
  "New Main Board",
  "Camera",
  "Buttons",
  "Button Pad",
  "Volume Buttons",
  "Hinge Tightening Or Wire Adjustment",
  "Remove Water",
  "Vibrator",
  "SIM Card Reader",
  "SD Card Reader",
  "Take Out Info",
  "Clean Mic or Charge Port",
];

// Repair price sheet, transcribed from the shop's Google Sheet. Each row is the
// 26 prices for a model, in the SAME order as `repairDamageTypes`. Values may be
// a fixed price ("$350.00"), a range ("80/90"), or "NA" (not offered).
const repairPriceRows = {
  "LG Exalt VN220": ["$350.00", "$95.00", "$95.00", "$95.00", "$125.00", "$125.00", "$150.00", "$90.00", "$90.00", "$90.00", "$125.00", "$35.00", "$75.00", "80/90", "200/300", "$65.00", "50/75", "$35.00", "$100.00", "35/50", "100/150", "65/85", "$65.00", "$100.00", "$50.00", "$35.00"],
  "LG Classic Flip": ["$95.00", "$100.00", "$100.00", "$100.00", "$125.00", "$85.00", "$85.00", "$90.00", "$90.00", "$90.00", "$125.00", "$35.00", "$65.00", "80/90", "$100.00", "$65.00", "50/75", "35/50", "50/65", "35/50", "100/150", "65/85", "$100.00", "$100.00", "$50.00", "$35.00"],
  "Kyocera E4610": ["$200.00", "$150.00", "$125.00", "$150.00", "$175.00", "$85.00", "$80.00", "$85.00", "$90.00", "$90.00", "$135.00", "$50.00", "$90.00", "$65.00", "$100.00", "$75.00", "50/65", "$35.00", "50/65", "$50.00", "100/150", "65/85", "$100.00", "$100.00", "50/75", "$50.00"],
  "Kyocera E4810": ["$200.00", "$135.00", "$135.00", "$150.00", "$200.00", "$85.00", "$80.00", "$105.00", "$90.00", "$90.00", "$135.00", "$50.00", "$85.00", "$65.00", "$100.00", "$75.00", "50/65", "$35.00", "50/65", "$50.00", "100/150", "65/85", "$100.00", "$100.00", "50/75", "35/50"],
  "Kyocera S2720": ["$250.00", "$135.00", "85/100", "100/135", "135/150", "$85.00", "$65.00", "$90.00", "$90.00", "$90.00", "$125.00", "$35.00", "$85.00", "80/90", "$100.00", "$65.00", "50/65", "$35.00", "50/65", "35/50", "100/150", "$100.00", "50/65", "50/65", "$50.00", "$35.00"],
  "Qin F30": ["NA", "NA", "NA", "NA", "NA", "$100.00", "NA", "$95.00", "$90.00", "$90.00", "$125.00", "65/100", "65/100", "NA", "100/150", "50/75", "35/80", "35/50", "NA", "35/50", "100/150", "75/100", "$100.00", "NA", "$50.00", "$35.00"],
  "TCL Flip 2": ["$75.00", "NA", "NA", "NA", "NA", "NA", "NA", "$85.00", "$85.00", "$85.00", "$110.00", "$35.00", "$65.00", "NA", "NA", "$65.00", "$50.00", "25/35", "NA", "35/50", "100/150", "65/90", "NA", "NA", "$50.00", "25/35"],
  "Alcatel 4051S": ["NA", "NA", "NA", "NA", "NA", "NA", "NA", "$90.00", "$85.00", "NA", "NA", "$35.00", "NA", "NA", "NA", "$35.00", "35/50", "$25.00", "$85.00", "35/50", "100/150", "NA", "NA", "$100.00", "$50.00", "25/35"],
  "POM TX 10": ["$130.00", "NA", "NA", "NA", "NA", "NA", "NA", "$100.00", "$90.00", "NA", "NA", "$50.00", "$79.00", "NA", "NA", "$35.00", "35/50", "$25.00", "25/35", "35/50", "100/150", "$35.00", "$100.00", "NA", "$75.00", "25/35"],
  "Pom Classic": ["$135.00", "$85.00", "$85.00", "$85.00", "$85.00", "NA", "$100.00", "$100.00", "$90.00", "$90.00", "$90.00", "$50.00", "$79.00", "80/90", "NA", "$75.00", "25/35", "25/35", "25/35", "35/50", "100/150", "$35.00", "$100.00", "NA", "$75.00", "25/35"],
  "FIG Flip 2 (F52)": ["$130.00", "$85.00", "$85.00", "$85.00", "$85.00", "NA", "$150.00", "$100.00", "$90.00", "$90.00", "$90.00", "$50.00", "$79.00", "80/90", "NA", "$75.00", "25/35", "25/35", "25/35", "35/50", "100/150", "$55.00", "$100.00", "NA", "$75.00", "25/35"],
  "FIG Mini (F45)": ["$130.00", "$85.00", "$85.00", "$85.00", "$85.00", "NA", "$100.00", "$100.00", "$90.00", "$90.00", "$90.00", "$50.00", "$79.00", "80/90", "NA", "$75.00", "25/35", "25/35", "25/35", "35/50", "100/150", "$55.00", "$100.00", "NA", "$75.00", "25/35"],
  "Coolpad": ["$125.00", "NA", "NA", "NA", "NA", "NA", "NA", "$90.00", "$90.00", "$90.00", "NA", "NA", "NA", "NA", "NA", "NA", "35/50", "$25.00", "$90.00", "35/50", "100/150", "NA", "NA", "NA", "$50.00", "25/35"],
  "Nokia 6300": ["$100.00", "NA", "NA", "NA", "NA", "NA", "NA", "$90.00", "$90.00", "$90.00", "NA", "NA", "NA", "NA", "NA", "NA", "35/50", "$25.00", "NA", "35/50", "100/150", "NA", "NA", "NA", "$50.00", "25/35"],
  "ANS F30": ["$65.00", "NA", "NA", "NA", "NA", "NA", "NA", "$90.00", "$90.00", "$90.00", "NA", "NA", "NA", "NA", "NA", "NA", "35/50", "$25.00", "$90.00", "35/50", "100/150", "NA", "NA", "NA", "$50.00", "25/35"],
  "Sunbeam": ["NA", "NA", "NA", "NA", "NA", "NA", "NA", "$90.00", "$90.00", "$90.00", "NA", "NA", "NA", "NA", "NA", "NA", "35/50", "$25.00", "$90.00", "35/50", "100/150", "$90.00", "NA", "NA", "$75.00", "$35.00"],
  "XP3 3800": ["$185.00", "NA", "NA", "NA", "NA", "65/85", "65/85", "$85.00", "$90.00", "$90.00", "NA", "NA", "NA", "$65.00", "NA", "NA", "35/50", "$25.00", "50/65", "35/50", "100/150", "$90.00", "NA", "NA", "50/75", "$50.00"],
  "XP3+ 3900": ["$195.00", "NA", "NA", "NA", "NA", "65/85", "65/85", "$85.00", "$90.00", "$90.00", "NA", "NA", "NA", "$65.00", "NA", "NA", "35/50", "$25.00", "50/65", "35/50", "100/150", "$90.00", "NA", "NA", "50/75", "$50.00"],
  "Etalk": ["$65.00", "NA", "NA", "NA", "NA", "NA", "NA", "$90.00", "$65.00", "NA", "NA", "NA", "NA", "NA", "NA", "NA", "35/50", "$25.00", "50/65", "NA", "100/150", "NA", "NA", "NA", "50/75", "$50.00"],
};

// Build a { model: { damageType: priceString } } lookup from the rows above.
export const repairPriceSheet = Object.fromEntries(
  Object.entries(repairPriceRows).map(([model, prices]) => [
    model,
    Object.fromEntries(prices.map((price, index) => [repairDamageTypes[index], price])),
  ]),
);

// Parses a raw sheet cell into a normalized price descriptor.
// - "$350.00" -> { kind: "fixed", amount: 350, display: "$350" }
// - "80/90"   -> { kind: "range", amount: 80, low: 80, high: 90, display: "80/90" }
// - "NA"/""   -> { kind: "na" } / { kind: "none" }
export function parseRepairPrice(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return { kind: "none", raw: value };
  if (value.toUpperCase() === "NA") return { kind: "na", raw: value };

  const toNumber = (text) => {
    const cleaned = String(text).replace(/[^0-9.]/g, "");
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  };

  if (value.includes("/")) {
    const [lowRaw, highRaw] = value.split("/");
    const low = toNumber(lowRaw);
    const high = toNumber(highRaw);
    return { kind: "range", amount: low, low, high, display: value, raw: value };
  }

  const amount = toNumber(value);
  if (amount == null) return { kind: "none", raw: value };
  return { kind: "fixed", amount, display: value, raw: value };
}

// Looks up the price for a model + damage/service pair. Returns null when either
// side is empty or not present in the sheet (e.g. a custom typed value), so the
// caller can leave the amount untouched for free-typed entries.
export function lookupRepairPrice(model, damage) {
  const modelKey = String(model || "").trim();
  const damageKey = String(damage || "").trim();
  if (!modelKey || !damageKey) return null;
  const row = repairPriceSheet[modelKey];
  if (!row) return null;
  if (!Object.prototype.hasOwnProperty.call(row, damageKey)) return null;
  return parseRepairPrice(row[damageKey]);
}

export const reportTypes = {
  call: {
    title: "Phone call report",
    label: "Phone call",
    mark: "C",
    description: "Inbound requests",
    fields: [
      { name: "callerName", label: "Caller name", placeholder: "Customer name" },
      { name: "reason", label: "What does the caller want?", placeholder: "Price check, repair update, sale question" },
      { name: "outcome", label: "Call outcome", placeholder: "Answered, needs follow-up, came in store" },
      { name: "followUpDate", label: "Follow-up date", type: "date" },
    ],
  },
  sale: {
    title: "Sale report",
    label: "Sale",
    mark: "S",
    description: "Phones and products",
    fields: [
      { name: "request", label: "What does the customer want?", placeholder: "Phone, charger, accessory, plan" },
      { name: "productType", label: "Product type", placeholder: "Phone" },
      { name: "model", label: "Phone model", placeholder: "iPhone 14 Pro" },
      { name: "imei", label: "IMEI", placeholder: "Scan or type 15-digit IMEI" },
    ],
  },
  repair: {
    title: "Repair report",
    label: "Repair",
    mark: "R",
    description: "Device service",
    fields: [
      { name: "model", label: "Phone model", placeholder: "Start typing a model…", suggestions: repairPhoneModels },
      { name: "damage", label: "What is damaged?", placeholder: "Start typing a repair…", suggestions: repairDamageTypes },
      { name: "status", label: "Repair status", type: "select", options: repairStatuses },
      { name: "paymentStatus", label: "Repair paid?", type: "select", options: ["Not paid", "Paid"] },
      { name: "notificationPreference", label: "When ready notify by", type: "select", options: ["Text message", "Phone call", "Both"] },
      { name: "dueDate", label: "Expected ready date", type: "date" },
    ],
  },
  sim: {
    title: "SIM activation report",
    label: "SIM activation",
    mark: "A",
    description: "Carrier setup",
    fields: [
      { name: "carrier", label: "Carrier", placeholder: "US Mobile, H2O, Ultra, Lyca" },
      { name: "simPhone", label: "SIM number", placeholder: "SIM / ICCID number" },
      { name: "plan", label: "Plan / activation notes", placeholder: "Monthly plan, port-in, new number" },
      { name: "accountPin", label: "PIN / account note", placeholder: "Optional" },
      { name: "planType", label: "Plan type", type: "select", options: ["Monthly", "One time"] },
      { name: "cardLast4", label: "Card last 4 digits", placeholder: "1234" },
      // Monthly plans repeat: we remind on this day-of-month every month.
      { name: "refillDate", label: "Monthly refill date", type: "date", showIf: { field: "planType", equals: "Monthly" } },
      // One-time plans fire a single reminder on this date.
      { name: "reminderDate", label: "Refill reminder date", type: "date", showIf: { field: "planType", equals: "One time" } },
      { name: "reminderPreference", label: "Remind by", type: "select", options: ["Text message", "Phone call", "Both"] },
    ],
  },
  rental: {
    title: "Phone rental report",
    label: "Phone rental",
    mark: "P",
    description: "Temporary devices",
    fields: [
      { name: "rentalType", label: "Rental type", type: "select", options: ["SIM only", "Phone", "Upgraded phone"] },
      { name: "model", label: "Phone model", placeholder: "iPhone 12, Galaxy A14" },
      { name: "imei", label: "IMEI / device ID", placeholder: "Optional for SIM only" },
      { name: "simNumber", label: "SIM number", placeholder: "SIM / ICCID number" },
      { name: "startDate", label: "Start date", type: "date" },
      { name: "endDate", label: "End date", type: "date" },
      { name: "returnTime", label: "Return time", type: "time" },
      { name: "deposit", label: "Deposit", placeholder: "0.00" },
    ],
  },
  phoneOrder: {
    title: "Phone order",
    label: "Phone order",
    mark: "O",
    description: "Manual deliveries",
    fields: [],
  },
  return: {
    title: "Return / refund",
    label: "Return",
    mark: "RT",
    description: "Refunds and restocks",
    fields: [],
  },
};

// Sale and call reports are imported from Shopify POS and Telebroad webhooks.
export const manualReportTypeKeys = ["repair", "sim", "rental", "phoneOrder"];
export const defaultManualReportType = manualReportTypeKeys[0];
