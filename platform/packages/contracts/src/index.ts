import { ADJUST_REASONS, ROLES, TENDER_METHODS, WORK_ORDER_STATUSES } from "@pos/domain";
import { z } from "zod";

/** Integer cents. Money never crosses the wire as a float or decimal string. */
export const Cents = z.number().int().safe();
export const PositiveCents = Cents.positive();
export const NonNegativeCents = Cents.nonnegative();
export const Uuid = z.string().uuid();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const IsoDateTime = z.string().datetime({ offset: true });
export const Phone = z.string().min(7).max(32);

// ---------------------------------------------------------------- errors
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "VERSION_MISMATCH",
  "INSUFFICIENT_STOCK",
  "UNIT_NOT_AVAILABLE",
  "TENDER_INVALID",
  "REFUND_EXCEEDS_PAYMENT",
  "RETURN_EXCEEDS_SOLD",
  "PAYMENT_STATE_INVALID",
  "INVALID_TRANSITION",
  "RATE_LIMITED",
  "WEBHOOK_SIGNATURE_INVALID",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof pageQuery>;
export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// ---------------------------------------------------------------- customers
export const UpsertCustomerCommand = z.object({
  phone: Phone,
  name: z.string().trim().max(120).optional(),
  email: z.string().email().max(200).optional(),
  address: z.string().max(300).optional(),
  mobile: Phone.optional(),
});
export type UpsertCustomerCommand = z.infer<typeof UpsertCustomerCommand>;

export const Customer = z.object({
  id: Uuid,
  phone: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  balanceCents: Cents,
  creditLimitCents: NonNegativeCents,
  version: z.number().int(),
});
export type Customer = z.infer<typeof Customer>;

export const LedgerAdjustCommand = z.object({
  amountCents: Cents.refine((v) => v !== 0, "must not be zero"),
  reason: z.string().trim().min(3).max(300),
});

// ---------------------------------------------------------------- sales
export const SaleLine = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("product"),
    variantId: Uuid,
    qty: z.number().int().positive().max(999),
    /** Optional override; when absent the catalog price is used server-side. */
    unitPriceCents: NonNegativeCents.optional(),
    adjustCode: z.string().max(12).optional(),
    imei: z.string().max(20).optional(),
  }),
  z.object({
    kind: z.literal("custom"),
    description: z.string().trim().min(1).max(200),
    qty: z.number().int().positive().max(999),
    unitPriceCents: NonNegativeCents,
    taxable: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("work_order"),
    workOrderId: Uuid,
  }),
]);
export type SaleLine = z.infer<typeof SaleLine>;

export const Tender = z.object({
  method: z.enum(TENDER_METHODS),
  amountCents: PositiveCents,
});

export const CreateSaleCommand = z.object({
  storeId: Uuid,
  registerId: Uuid.optional(),
  customerId: Uuid.optional(),
  lines: z.array(SaleLine).min(1).max(200),
  tenders: z.array(Tender).max(4),
  collectLater: z.object({ dueDate: IsoDate }).optional(),
  outOfState: z.boolean().default(false),
  notes: z.string().max(1000).optional(),
  /** Client-generated id so an offline register can print a receipt before sync. */
  clientOrderId: Uuid.optional(),
});
export type CreateSaleCommand = z.infer<typeof CreateSaleCommand>;

export const PaymentStatus = z.enum([
  "requires_action",
  "processing",
  "pending_verification",
  "captured",
  "declined",
  "failed",
  "voided",
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const Payment = z.object({
  id: Uuid,
  orderId: Uuid,
  method: z.enum(TENDER_METHODS),
  amountCents: Cents,
  refundedCents: NonNegativeCents,
  status: PaymentStatus,
  externalRequestId: z.string().nullable(),
  gatewayRef: z.string().nullable(),
  cardSummary: z.string().nullable(),
});
export type Payment = z.infer<typeof Payment>;

export const OrderLine = z.object({
  id: Uuid,
  kind: z.string(),
  description: z.string(),
  variantId: Uuid.nullable(),
  workOrderId: Uuid.nullable(),
  serializedUnitId: Uuid.nullable(),
  imei: z.string().nullable(),
  qty: z.number().int(),
  returnedQty: z.number().int(),
  unitPriceCents: Cents,
  netCents: Cents,
  taxCents: Cents,
});

export const Order = z.object({
  id: Uuid,
  kind: z.enum(["sale", "return"]),
  status: z.enum(["awaiting_payment", "completed", "balance_due", "voided"]),
  receiptCode: z.string(),
  storeId: Uuid,
  customerId: Uuid.nullable(),
  subtotalCents: Cents,
  taxCents: Cents,
  totalCents: Cents,
  paidCents: Cents,
  balanceDueCents: Cents,
  balanceDueDate: z.string().nullable(),
  taxRatePpm: z.number().int(),
  createdAt: z.string(),
  lines: z.array(OrderLine),
  payments: z.array(Payment),
});
export type Order = z.infer<typeof Order>;

export const ReturnCommand = z.object({
  lines: z
    .array(z.object({ orderLineId: Uuid, qty: z.number().int().positive(), restock: z.boolean().default(true) }))
    .min(1),
  /** How the refund goes back. Card refunds must reference the original card payment. */
  refunds: z
    .array(
      z.object({
        paymentId: Uuid,
        amountCents: PositiveCents,
      }),
    )
    .min(1),
  reason: z.string().trim().min(2).max(300),
  registerId: Uuid.optional(),
});
export type ReturnCommand = z.infer<typeof ReturnCommand>;

// ---------------------------------------------------------------- payments
export const CreatePaymentIntentCommand = z.object({
  orderId: Uuid,
  amountCents: PositiveCents,
  method: z.literal("card"),
  terminalId: z.string().max(80).optional(),
  manualEntry: z.boolean().default(false),
});
export type CreatePaymentIntentCommand = z.infer<typeof CreatePaymentIntentCommand>;

export const CollectPaymentCommand = z.object({
  orderId: Uuid,
  tenders: z.array(Tender).min(1).max(4),
});

// ---------------------------------------------------------------- work orders
export const CreateWorkOrderCommand = z.object({
  storeId: Uuid,
  customerId: Uuid.optional(),
  customerPhone: Phone.optional(),
  customerName: z.string().max(120).optional(),
  model: z.string().trim().min(1).max(120),
  imei: z.string().max(20).optional(),
  issue: z.string().trim().min(1).max(500),
  fixes: z.array(z.object({ description: z.string().trim().min(1).max(200), priceCents: NonNegativeCents })).max(20).default([]),
  estimateCents: NonNegativeCents.optional(),
  expectedReadyDate: IsoDate.optional(),
  notifyBy: z.enum(["sms", "voice", "both"]).default("sms"),
  devicePasscode: z.string().max(64).optional(),
  accountPin: z.string().max(64).optional(),
  hadSim: z.boolean().default(false),
  hadSdCard: z.boolean().default(false),
  loanerGiven: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
  /** A ticket reserved from this register's offline block, if the intake happened offline. */
  reservedTicket: z.number().int().optional(),
  registerId: Uuid.optional(),
});
export type CreateWorkOrderCommand = z.infer<typeof CreateWorkOrderCommand>;

export const UpdateWorkOrderStatusCommand = z.object({
  status: z.enum(WORK_ORDER_STATUSES),
  expectedVersion: z.number().int().positive(),
  /** When set in the future on a move to "ready", the text is scheduled instead of sent now. */
  notifyAt: IsoDateTime.optional(),
  finalPriceCents: NonNegativeCents.optional(),
  note: z.string().max(1000).optional(),
});
export type UpdateWorkOrderStatusCommand = z.infer<typeof UpdateWorkOrderStatusCommand>;

export const WorkOrder = z.object({
  id: Uuid,
  ticketNumber: z.number().int(),
  storeId: Uuid,
  customerId: Uuid.nullable(),
  customerPhone: z.string().nullable(),
  customerName: z.string().nullable(),
  model: z.string(),
  imei: z.string().nullable(),
  issue: z.string(),
  fixes: z.array(z.object({ description: z.string(), priceCents: Cents })),
  estimateCents: Cents.nullable(),
  finalPriceCents: Cents.nullable(),
  totalCents: Cents,
  paidCents: Cents,
  status: z.enum(WORK_ORDER_STATUSES),
  readyNotifyAt: z.string().nullable(),
  expectedReadyDate: z.string().nullable(),
  hasDevicePasscode: z.boolean(),
  notes: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

export const ReserveTicketBlockCommand = z.object({ registerId: Uuid, size: z.number().int().min(1).max(200).optional() });

// ---------------------------------------------------------------- stock
export const StockReceiveCommand = z.object({
  storeId: Uuid,
  lines: z
    .array(
      z.object({
        variantId: Uuid,
        qty: z.number().int().positive().max(100_000).optional(),
        imeis: z.array(z.string().min(14).max(20)).max(500).optional(),
        unitCostCents: NonNegativeCents.optional(),
      }),
    )
    .min(1)
    .max(500),
  reference: z.string().max(120).optional(),
});
export type StockReceiveCommand = z.infer<typeof StockReceiveCommand>;

export const StockTransferCommand = z.object({
  fromStoreId: Uuid,
  toStoreId: Uuid,
  lines: z
    .array(z.object({ variantId: Uuid, qty: z.number().int().positive().optional(), imeis: z.array(z.string()).optional() }))
    .min(1),
  note: z.string().max(300).optional(),
});
export type StockTransferCommand = z.infer<typeof StockTransferCommand>;

export const StockCountCommand = z.object({
  storeId: Uuid,
  counts: z.array(z.object({ variantId: Uuid, countedQty: z.number().int().nonnegative() })).min(1).max(2000),
  note: z.string().max(300).optional(),
});
export type StockCountCommand = z.infer<typeof StockCountCommand>;

export const StockAdjustCommand = z.object({
  storeId: Uuid,
  variantId: Uuid,
  qty: z.number().int().refine((v) => v !== 0, "must not be zero"),
  reason: z.enum(ADJUST_REASONS),
  note: z.string().max(300).optional(),
});

export const CreateProductCommand = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(60).default("Other"),
  taxCategory: z.string().max(60).optional(),
  variants: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(64),
        name: z.string().trim().max(200).optional(),
        barcode: z.string().trim().max(64).optional(),
        priceCents: NonNegativeCents,
        serialized: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(50),
});

// ---------------------------------------------------------------- rentals
export const CreateRentalCommand = z.object({
  storeId: Uuid,
  customerId: Uuid,
  region: z.string().min(1).max(60),
  serviceType: z.string().min(1).max(60),
  addSms: z.boolean().default(false),
  deviceKind: z.enum(["sim_only", "phone", "upgraded_phone"]),
  serializedUnitId: Uuid.optional(),
  simNumber: z.string().min(5).max(30),
  startDate: IsoDate,
  endDate: IsoDate,
  graceDays: z.number().int().min(0).max(60).default(0),
  depositCents: NonNegativeCents.optional(),
  lateFeeWeeklyCents: NonNegativeCents.default(0),
});
export type CreateRentalCommand = z.infer<typeof CreateRentalCommand>;

export const ReturnRentalCommand = z.object({
  returnedOn: IsoDate,
  expectedVersion: z.number().int().positive(),
  waiveLateFee: z.boolean().default(false),
});

// ---------------------------------------------------------------- phone orders
export const CreatePhoneOrderCommand = z.object({
  storeId: Uuid,
  customerId: Uuid,
  model: z.string().min(1).max(120),
  address: z.string().min(3).max(300),
  amountCents: NonNegativeCents,
  notes: z.string().max(1000).optional(),
});
export const AssignPhoneOrderCommand = z.object({ driverMembershipId: Uuid, expectedVersion: z.number().int().positive() });
export const DeliverPhoneOrderCommand = z.object({ expectedVersion: z.number().int().positive() });

// ---------------------------------------------------------------- shifts
export const OpenShiftCommand = z.object({ registerId: Uuid, openingFloatCents: NonNegativeCents });
export const CashMovementCommand = z.object({
  amountCents: Cents.refine((v) => v !== 0),
  reason: z.string().trim().min(2).max(200),
});
export const CloseShiftCommand = z.object({ countedCashCents: NonNegativeCents, note: z.string().max(500).optional() });

// ---------------------------------------------------------------- auth / staff
export const PinSwitchCommand = z.object({ membershipId: Uuid, pin: z.string().regex(/^\d{4,8}$/) });
export const SetPinCommand = z.object({ pin: z.string().regex(/^\d{4,8}$/) });
export const InviteMemberCommand = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  role: z.enum(ROLES),
  storeId: Uuid.optional(),
});

// ---------------------------------------------------------------- read models
export const CatalogItem = z.object({
  variantId: Uuid,
  productId: Uuid,
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  barcode: z.string().nullable(),
  priceCents: Cents,
  serialized: z.boolean(),
});
export type CatalogItem = z.infer<typeof CatalogItem>;

export const StockBalance = z.object({
  variantId: Uuid,
  storeId: Uuid,
  sku: z.string(),
  name: z.string(),
  serialized: z.boolean(),
  qty: z.number().int(),
  version: z.number().int(),
});
export type StockBalance = z.infer<typeof StockBalance>;

export const StockMovement = z.object({
  id: Uuid,
  storeId: Uuid,
  variantId: Uuid,
  kind: z.string(),
  qtyDelta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  createdAt: z.string(),
});

export const LedgerEntry = z.object({
  id: Uuid,
  amountCents: Cents,
  kind: z.string(),
  reason: z.string().nullable(),
  orderId: Uuid.nullable(),
  createdAt: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const CreateSaleResult = z.object({
  order: Order,
  /** One per card tender: the register then calls /payments/:id/confirm to run the terminal. */
  pendingPayments: z.array(Payment),
});
export type CreateSaleResult = z.infer<typeof CreateSaleResult>;

export const WorkOrderPrint = z.object({
  workOrder: WorkOrder,
  devicePasscode: z.string().nullable(),
  store: z.object({ name: z.string(), address: z.string(), phone: z.string(), hours: z.string(), timeZone: z.string() }),
  company: z.object({ name: z.string(), phone: z.string(), web: z.string(), currency: z.string() }),
  receiptNote: z.string().nullable(),
});
export type WorkOrderPrint = z.infer<typeof WorkOrderPrint>;

export const Me = z.object({
  userId: Uuid,
  displayName: z.string(),
  tenantId: Uuid,
  tenantName: z.string(),
  memberships: z.array(z.object({ id: Uuid, role: z.enum(ROLES), storeId: Uuid.nullable() })),
  stores: z.array(z.object({ id: Uuid, name: z.string(), code: z.string() })),
});
export type Me = z.infer<typeof Me>;
