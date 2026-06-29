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
      { name: "notificationPreference", label: "When ready notify by", type: "select", options: ["Text message", "Phone call"] },
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
      { name: "reminderDate", label: "Refill reminder date", type: "date" },
      { name: "cardLast4", label: "Card last 4 digits", placeholder: "1234" },
      { name: "reminderPreference", label: "Remind by", type: "select", options: ["Text message", "Phone call"] },
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
