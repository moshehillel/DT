import { DIAMANT_RENTAL_PRICE_BOOK, type RentalPriceBook } from "./rental.js";
import { DEFAULT_TAX_RULES, percentToPpm, type TaxRuleSet } from "./tax.js";

/**
 * Notification templates are per tenant; these keys are what the API enqueues.
 * Variables available to each are listed so the admin UI can validate edits.
 */
export const NOTIFICATION_TEMPLATE_KEYS = {
  repair_received: ["company", "model", "ticket", "issue", "expectedReady", "paymentLine"],
  repair_ready: ["company", "model", "ticket", "amountDueLine"],
  repair_paid: ["company", "model", "ticket"],
  payment_reminder: ["company", "amount", "companyPhone"],
  payment_request: ["company", "amount", "companyPhone"],
  rental_return_reminder: ["company", "returnDate", "companyPhone"],
  phone_order_assigned: ["company", "model", "assignee"],
  phone_order_delivered: ["company", "model"],
} as const;
export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATE_KEYS;

export const DEFAULT_TEMPLATES: Record<NotificationTemplateKey, string> = {
  repair_received:
    "{{company}}: we received your {{model}} for repair. Ticket #{{ticket}}. {{issue}} {{expectedReady}} {{paymentLine}} We'll text you when it's ready.",
  repair_ready: "{{company}}: repair ticket {{ticket}} for {{model}} is ready for pickup. {{amountDueLine}}",
  repair_paid: "{{company}}: payment for your {{model}} repair ticket {{ticket}} is marked paid. Thank you!",
  payment_reminder: "{{company}}: a payment of {{amount}} is due. Call {{companyPhone}} or come in to pay.",
  payment_request: "{{company}}: please pay {{amount}}. Call {{companyPhone}} or come in to the store.",
  rental_return_reminder:
    "{{company}}: your rental phone is due back on {{returnDate}}. Questions? Call {{companyPhone}}.",
  phone_order_assigned:
    "{{company}}: your phone order for {{model}} was assigned to {{assignee}}. We will contact you with updates.",
  phone_order_delivered: "{{company}}: your phone order for {{model}} has been delivered. Thank you.",
};

export interface StoreSeed {
  code: string;
  name: string;
  address: string;
  phone: string;
  hours: string;
  timeZone: string;
  taxRules: TaxRuleSet;
  /** Flag shown in admin until someone confirms the rate with the accountant. */
  taxRateNeedsConfirmation: boolean;
}

export interface TenantSeed {
  slug: string;
  name: string;
  company: { phone: string; web: string; email: string };
  currency: string;
  stores: StoreSeed[];
  receiptNotes: Record<string, string>;
  rentalPriceBook: RentalPriceBook;
  settings: { allowNegativeStock: boolean; defaultCreditLimitCents: number; ticketBlockSize: number };
}

const nyStore = (percent: string): Pick<StoreSeed, "taxRules" | "taxRateNeedsConfirmation" | "timeZone"> => ({
  taxRules: { ...DEFAULT_TAX_RULES, ratePpm: percentToPpm(percent) },
  // The live app keeps each store's rate in Firestore; these county rates are
  // placeholders until the tenant (and accountant) confirm them in admin.
  taxRateNeedsConfirmation: true,
  timeZone: "America/New_York",
});

/** Tenant #1, transcribed from src/constants.js of the original app. */
export const DIAMANT_TENANT_SEED: TenantSeed = {
  slug: "diamant-telecom",
  name: "Diamant Telecom",
  company: { phone: "1 (347) 388-7467", web: "diamanttelecom.com", email: "diamanttelecom@gmail.com" },
  currency: "USD",
  stores: [
    {
      code: "BKN",
      name: "Brooklyn Store",
      address: "803 Bedford Ave Suite 104, Brooklyn, NY 11205",
      phone: "(347) 388-7467",
      hours: "Sun 12PM-6:30PM · Mon-Thu 10:30AM-6:30PM",
      ...nyStore("8.875"),
    },
    {
      code: "UPS",
      name: "Upstate Store",
      address: "1 Maglenitz St #001, Monroe, NY 10950",
      phone: "(347) 388-7467",
      hours: "Sun 12PM-6:30PM · Mon-Thu 10:30AM-6:30PM",
      ...nyStore("8.125"),
    },
    {
      code: "CAT",
      name: "Catskills Store",
      address: "Home Square — 335 E Broadway, Monticello, NY 12701",
      phone: "(845) 685-6000",
      hours: "",
      ...nyStore("8"),
    },
  ],
  receiptNotes: {},
  rentalPriceBook: DIAMANT_RENTAL_PRICE_BOOK,
  settings: { allowNegativeStock: false, defaultCreditLimitCents: 0, ticketBlockSize: 25 },
};
