import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Conventions
 *  - every tenant-owned table has tenant_id and is protected by row-level
 *    security on app.tenant_id (see migrations/0001_rls.sql)
 *  - money is integer cents (`*_cents integer`)
 *  - mutable rows carry `version` for optimistic concurrency
 *  - ledgers (stock_movements, customer_ledger_entries, audit_log,
 *    work_order_events, tax_lines) are append-only: UPDATE/DELETE are revoked
 *  - created_by is the authenticated user id (never a browser-supplied name)
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const tenantId = () => uuid("tenant_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const createdBy = () => uuid("created_by");
const version = () => integer("version").notNull().default(1);

// ------------------------------------------------------------------ tenancy & identity
export const tenants = pgTable("tenants", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Company info, currency, stock policy, rental price book, receipt notes. Validated by the API. */
  settings: jsonb("settings").notNull().default({}),
  createdAt: createdAt(),
  version: version(),
});

/** Global identities (one per Firebase/Identity Platform user). Tenant access is via memberships. */
export const users = pgTable("users", {
  id: id(),
  firebaseUid: text("firebase_uid").notNull().unique(),
  email: text("email"),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const stores = pgTable(
  "stores",
  {
    id: id(),
    tenantId: tenantId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address").notNull().default(""),
    phone: text("phone").notNull().default(""),
    hours: text("hours").notNull().default(""),
    timeZone: text("time_zone").notNull().default("America/New_York"),
    taxRules: jsonb("tax_rules").notNull(),
    taxRateNeedsConfirmation: boolean("tax_rate_needs_confirmation").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [uniqueIndex("stores_tenant_code_uq").on(t.tenantId, t.code)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    /** Null = tenant-wide; set = limited to one store. */
    storeId: uuid("store_id").references(() => stores.id),
    /** scrypt hash for the till PIN switch. Never stored or returned in plain text. */
    pinHash: text("pin_hash"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [
    uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId),
    check("memberships_role_ck", sql`${t.role} in ('owner','manager','cashier','technician','driver')`),
  ],
);

export const registers = pgTable("registers", {
  id: id(),
  tenantId: tenantId(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id),
  name: text("name").notNull(),
  /** Card terminal device id (Cardknox xDeviceId). Changing it is a settings.write action. */
  terminalDeviceId: text("terminal_device_id"),
  createdAt: createdAt(),
  createdBy: createdBy(),
  version: version(),
});

// ------------------------------------------------------------------ catalog & stock
export const products = pgTable("products", {
  id: id(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  category: text("category").notNull().default("Other"),
  taxCategory: text("tax_category"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  createdBy: createdBy(),
  version: version(),
});

export const productVariants = pgTable(
  "product_variants",
  {
    id: id(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    barcode: text("barcode"),
    priceCents: integer("price_cents").notNull(),
    serialized: boolean("serialized").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [
    uniqueIndex("variants_tenant_sku_uq").on(t.tenantId, t.sku),
    uniqueIndex("variants_tenant_barcode_uq").on(t.tenantId, t.barcode).where(sql`${t.barcode} is not null`),
    check("variants_price_ck", sql`${t.priceCents} >= 0`),
  ],
);

export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    tenantId: tenantId(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    qty: integer("qty").notNull().default(0),
    version: version(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.variantId] }), index("balances_tenant_idx").on(t.tenantId)],
);

export const serializedUnits = pgTable(
  "serialized_units",
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    storeId: uuid("store_id").references(() => stores.id),
    imei: text("imei").notNull(),
    status: text("status").notNull().default("in_stock"),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [
    uniqueIndex("units_tenant_imei_uq").on(t.tenantId, t.imei),
    check(
      "units_status_ck",
      sql`${t.status} in ('in_stock','sold','rma','rental_fleet','in_transit','written_off')`,
    ),
  ],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    kind: text("kind").notNull(),
    qtyDelta: integer("qty_delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason"),
    unitCostCents: integer("unit_cost_cents"),
    serializedUnitId: uuid("serialized_unit_id").references(() => serializedUnits.id),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    transferGroupId: uuid("transfer_group_id"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [
    index("movements_store_variant_idx").on(t.tenantId, t.storeId, t.variantId, t.createdAt),
    check(
      "movements_kind_ck",
      sql`${t.kind} in ('receive','sale','return','transfer_out','transfer_in','adjust','count','rental_out','rental_in')`,
    ),
  ],
);

// ------------------------------------------------------------------ customers
export const customers = pgTable(
  "customers",
  {
    id: id(),
    tenantId: tenantId(),
    /** E.164; unique per tenant so concurrent upserts converge on one row. */
    phone: text("phone").notNull(),
    name: text("name"),
    email: text("email"),
    address: text("address"),
    mobile: text("mobile"),
    creditLimitCents: integer("credit_limit_cents").notNull().default(0),
    mergedIntoId: uuid("merged_into_id"),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [uniqueIndex("customers_tenant_phone_uq").on(t.tenantId, t.phone)],
);

/** Balance = sum(amount_cents). Positive = credit held for the customer; negative = owed to the shop. */
export const customerLedgerEntries = pgTable(
  "customer_ledger_entries",
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    amountCents: integer("amount_cents").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason"),
    orderId: uuid("order_id"),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [index("ledger_customer_idx").on(t.tenantId, t.customerId, t.createdAt)],
);

// ------------------------------------------------------------------ orders & payments
export const orders = pgTable(
  "orders",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    registerId: uuid("register_id").references(() => registers.id),
    kind: text("kind").notNull(),
    originalOrderId: uuid("original_order_id"),
    status: text("status").notNull(),
    receiptCode: text("receipt_code").notNull(),
    customerId: uuid("customer_id").references(() => customers.id),
    subtotalCents: integer("subtotal_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    paidCents: integer("paid_cents").notNull().default(0),
    balanceDueDate: date("balance_due_date"),
    taxRatePpm: integer("tax_rate_ppm").notNull().default(0),
    taxRulesSnapshot: jsonb("tax_rules_snapshot").notNull(),
    outOfState: boolean("out_of_state").notNull().default(false),
    notes: text("notes"),
    clientOrderId: uuid("client_order_id"),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [
    uniqueIndex("orders_tenant_receipt_uq").on(t.tenantId, t.receiptCode),
    uniqueIndex("orders_tenant_client_uq").on(t.tenantId, t.clientOrderId).where(sql`${t.clientOrderId} is not null`),
    index("orders_store_created_idx").on(t.tenantId, t.storeId, t.createdAt),
    check("orders_kind_ck", sql`${t.kind} in ('sale','return')`),
    check("orders_status_ck", sql`${t.status} in ('awaiting_payment','completed','balance_due','voided')`),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    variantId: uuid("variant_id").references(() => productVariants.id),
    serializedUnitId: uuid("serialized_unit_id").references(() => serializedUnits.id),
    imei: text("imei"),
    workOrderId: uuid("work_order_id"),
    rentalContractId: uuid("rental_contract_id"),
    originalLineId: uuid("original_line_id"),
    qty: integer("qty").notNull(),
    returnedQty: integer("returned_qty").notNull().default(0),
    unitPriceCents: integer("unit_price_cents").notNull(),
    adjustCents: integer("adjust_cents").notNull().default(0),
    netCents: integer("net_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    refundedNetCents: integer("refunded_net_cents").notNull().default(0),
    refundedTaxCents: integer("refunded_tax_cents").notNull().default(0),
    taxCategory: text("tax_category"),
  },
  (t) => [
    index("order_lines_order_idx").on(t.orderId),
    check("order_lines_returned_ck", sql`${t.returnedQty} >= 0 and ${t.returnedQty} <= ${t.qty}`),
    check(
      "order_lines_refund_ck",
      sql`${t.refundedNetCents} <= ${t.netCents} and ${t.refundedTaxCents} <= ${t.taxCents}`,
    ),
  ],
);

export const taxLines = pgTable("tax_lines", {
  id: id(),
  tenantId: tenantId(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  orderLineId: uuid("order_line_id").references(() => orderLines.id),
  jurisdiction: text("jurisdiction").notNull(),
  ratePpm: integer("rate_ppm").notNull(),
  taxableCents: integer("taxable_cents").notNull(),
  taxCents: integer("tax_cents").notNull(),
  flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
});

export const payments = pgTable(
  "payments",
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    method: text("method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    refundedCents: integer("refunded_cents").notNull().default(0),
    status: text("status").notNull(),
    /** Fixed before the terminal is ever asked to charge; the only key used to query an unknown outcome. */
    externalRequestId: text("external_request_id"),
    gateway: text("gateway"),
    gatewayRef: text("gateway_ref"),
    cardSummary: text("card_summary"),
    terminalId: text("terminal_id"),
    manualEntry: boolean("manual_entry").notNull().default(false),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [
    uniqueIndex("payments_external_request_uq").on(t.tenantId, t.externalRequestId),
    index("payments_order_idx").on(t.orderId),
    check("payments_amount_ck", sql`${t.amountCents} > 0`),
    check("payments_refund_cap_ck", sql`${t.refundedCents} >= 0 and ${t.refundedCents} <= ${t.amountCents}`),
    check(
      "payments_status_ck",
      sql`${t.status} in ('requires_action','processing','pending_verification','captured','declined','failed','voided')`,
    ),
  ],
);

export const refunds = pgTable("refunds", {
  id: id(),
  tenantId: tenantId(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payments.id),
  returnOrderId: uuid("return_order_id").references(() => orders.id),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull(),
  externalRequestId: text("external_request_id"),
  gatewayRef: text("gateway_ref"),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

export const shifts = pgTable(
  "shifts",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    registerId: uuid("register_id")
      .notNull()
      .references(() => registers.id),
    status: text("status").notNull().default("open"),
    openingFloatCents: integer("opening_float_cents").notNull(),
    expectedCashCents: integer("expected_cash_cents"),
    countedCashCents: integer("counted_cash_cents"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedBy: uuid("opened_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    note: text("note"),
    version: version(),
  },
  (t) => [uniqueIndex("shifts_one_open_per_register_uq").on(t.registerId).where(sql`${t.status} = 'open'`)],
);

export const cashMovements = pgTable("cash_movements", {
  id: id(),
  tenantId: tenantId(),
  shiftId: uuid("shift_id")
    .notNull()
    .references(() => shifts.id),
  kind: text("kind").notNull(),
  amountCents: integer("amount_cents").notNull(),
  orderId: uuid("order_id"),
  reason: text("reason"),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

// ------------------------------------------------------------------ repairs
export const ticketCounters = pgTable("ticket_counters", {
  tenantId: uuid("tenant_id").primaryKey(),
  nextValue: integer("next_value").notNull().default(100001),
});

export const ticketBlocks = pgTable("ticket_blocks", {
  id: id(),
  tenantId: tenantId(),
  registerId: uuid("register_id")
    .notNull()
    .references(() => registers.id),
  startValue: integer("start_value").notNull(),
  endValue: integer("end_value").notNull(),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

export const workOrders = pgTable(
  "work_orders",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    ticketNumber: integer("ticket_number").notNull(),
    customerId: uuid("customer_id").references(() => customers.id),
    customerPhone: text("customer_phone"),
    customerName: text("customer_name"),
    model: text("model").notNull(),
    imei: text("imei"),
    issue: text("issue").notNull(),
    fixes: jsonb("fixes").notNull().default([]),
    estimateCents: integer("estimate_cents"),
    finalPriceCents: integer("final_price_cents"),
    paidCents: integer("paid_cents").notNull().default(0),
    status: text("status").notNull().default("received"),
    notifyBy: text("notify_by").notNull().default("sms"),
    readyNotifyAt: timestamp("ready_notify_at", { withTimezone: true }),
    expectedReadyDate: date("expected_ready_date"),
    /** AES-256-GCM envelopes (see api/src/lib/crypto.ts). Cleared on pickup/cancel. */
    devicePasscodeEnc: text("device_passcode_enc"),
    accountPinEnc: text("account_pin_enc"),
    hadSim: boolean("had_sim").notNull().default(false),
    hadSdCard: boolean("had_sd_card").notNull().default(false),
    loanerGiven: boolean("loaner_given").notNull().default(false),
    notes: text("notes"),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    createdAt: createdAt(),
    createdBy: createdBy(),
    version: version(),
  },
  (t) => [
    uniqueIndex("work_orders_tenant_ticket_uq").on(t.tenantId, t.ticketNumber),
    index("work_orders_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("work_orders_phone_idx").on(t.tenantId, t.customerPhone),
    check(
      "work_orders_status_ck",
      sql`${t.status} in ('received','diagnosing','waiting_for_parts','in_repair','ready','picked_up','cancelled')`,
    ),
  ],
);

export const workOrderTicketAliases = pgTable(
  "work_order_ticket_aliases",
  {
    tenantId: tenantId(),
    alias: text("alias").notNull(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.alias] })],
);

export const workOrderEvents = pgTable(
  "work_order_events",
  {
    id: id(),
    tenantId: tenantId(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id),
    kind: text("kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),
    data: jsonb("data").notNull().default({}),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  (t) => [index("work_order_events_wo_idx").on(t.workOrderId, t.createdAt)],
);

// ------------------------------------------------------------------ rentals & phone orders
export const rentalContracts = pgTable("rental_contracts", {
  id: id(),
  tenantId: tenantId(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id),
  orderId: uuid("order_id").references(() => orders.id),
  region: text("region").notNull(),
  serviceType: text("service_type").notNull(),
  addSms: boolean("add_sms").notNull().default(false),
  deviceKind: text("device_kind").notNull(),
  serializedUnitId: uuid("serialized_unit_id").references(() => serializedUnits.id),
  simNumber: text("sim_number").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  returnDueDate: date("return_due_date").notNull(),
  totalCents: integer("total_cents").notNull(),
  lateFeeWeeklyCents: integer("late_fee_weekly_cents").notNull().default(0),
  lateFeeCents: integer("late_fee_cents").notNull().default(0),
  status: text("status").notNull().default("active"),
  returnedOn: date("returned_on"),
  externalRentalId: text("external_rental_id"),
  numbersStatus: text("numbers_status").notNull().default("pending"),
  createdAt: createdAt(),
  createdBy: createdBy(),
  version: version(),
});

export const rentalLines = pgTable("rental_lines", {
  id: id(),
  tenantId: tenantId(),
  rentalId: uuid("rental_id")
    .notNull()
    .references(() => rentalContracts.id),
  kind: text("kind").notNull(),
  amountCents: integer("amount_cents").notNull(),
  orderLineId: uuid("order_line_id").references(() => orderLines.id),
  createdAt: createdAt(),
});

export const rentalDeposits = pgTable("rental_deposits", {
  id: id(),
  tenantId: tenantId(),
  rentalId: uuid("rental_id")
    .notNull()
    .references(() => rentalContracts.id),
  amountCents: integer("amount_cents").notNull(),
  paymentId: uuid("payment_id").references(() => payments.id),
  status: text("status").notNull().default("held"),
  createdAt: createdAt(),
  version: version(),
});

export const phoneOrders = pgTable("phone_orders", {
  id: id(),
  tenantId: tenantId(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id),
  model: text("model").notNull(),
  address: text("address").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("new"),
  driverMembershipId: uuid("driver_membership_id").references(() => memberships.id),
  notes: text("notes"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
  createdBy: createdBy(),
  version: version(),
});

export const deliveries = pgTable("deliveries", {
  id: id(),
  tenantId: tenantId(),
  phoneOrderId: uuid("phone_order_id")
    .notNull()
    .references(() => phoneOrders.id),
  driverMembershipId: uuid("driver_membership_id").references(() => memberships.id),
  status: text("status").notNull(),
  createdAt: createdAt(),
  createdBy: createdBy(),
});

// ------------------------------------------------------------------ notifications & integration
export const notificationTemplates = pgTable(
  "notification_templates",
  {
    tenantId: tenantId(),
    key: text("key").notNull(),
    channel: text("channel").notNull().default("sms"),
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key, t.channel] })],
);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    tenantId: tenantId(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    /** One message per business event: replays and retries collapse onto the same row. */
    dedupeKey: text("dedupe_key").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    lastError: text("last_error"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("outbox_tenant_dedupe_uq").on(t.tenantId, t.dedupeKey),
    index("outbox_due_idx").on(t.status, t.availableAt),
    check(
      "outbox_status_ck",
      sql`${t.status} in ('pending','processing','done','dead','cancelled','needs_review')`,
    ),
  ],
);

export const notificationAttempts = pgTable("notification_attempts", {
  id: id(),
  tenantId: tenantId(),
  outboxId: uuid("outbox_id")
    .notNull()
    .references(() => outbox.id),
  channel: text("channel").notNull(),
  toAddress: text("to_address").notNull(),
  body: text("body").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: tenantId(),
    actorUserId: uuid("actor_user_id"),
    actorMembershipId: uuid("actor_membership_id"),
    operatorMembershipId: uuid("operator_membership_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    requestId: text("request_id"),
    storeId: uuid("store_id"),
    registerId: uuid("register_id"),
    ip: inet("ip"),
    data: jsonb("data").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.tenantId, t.entityType, t.entityId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    tenantId: tenantId(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("webhook_events_uq").on(t.tenantId, t.provider, t.eventId)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: tenantId(),
    key: text("key").notNull(),
    userId: uuid("user_id"),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
