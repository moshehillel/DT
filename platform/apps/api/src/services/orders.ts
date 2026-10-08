import { randomBytes, randomUUID } from "node:crypto";
import {
  formatMoney,
  planTenders,
  priceSale,
  zonedTimeToUtc,
  type TaxRuleSet,
  type TenderInput,
} from "@pos/domain";
import type { TxHandle } from "@pos/db";
import { AppError, notFound } from "../lib/errors.js";
import { cancelPending } from "../lib/outbox.js";
import { addLedgerEntry, getCustomer } from "./customers.js";
import { queueCustomerMessage } from "./notifications.js";
import { applyMovement } from "./stock.js";
import type { StoreRow, TenantSettings } from "./tenant.js";

export type LineKind = "product" | "custom" | "work_order" | "rental" | "deposit" | "late_fee";

export interface InternalLine {
  kind: LineKind;
  description: string;
  qty: number;
  unitPriceCents: number;
  adjustCents?: number;
  taxCategory?: string | null;
  taxable?: boolean;
  variantId?: string | null;
  serializedUnitId?: string | null;
  imei?: string | null;
  workOrderId?: string | null;
  rentalContractId?: string | null;
  /** Decrement stock at this store for this line. */
  moveStock?: boolean;
}

export interface CreateOrderInput {
  store: StoreRow;
  tenant: TenantSettings;
  registerId?: string | null;
  customerId?: string | null;
  lines: InternalLine[];
  tenders: TenderInput[];
  collectLater?: { dueDate: string } | null;
  outOfState?: boolean;
  notes?: string | null;
  clientOrderId?: string | null;
}

interface Ctx {
  tenantId: string;
  /** null for system actions (worker reconciliation). */
  userId: string | null;
}

export function newExternalRequestId(): string {
  return randomUUID().replace(/-/g, "");
}

async function newReceiptCode(tx: TxHandle): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const taken = await tx.client.query(`SELECT 1 FROM orders WHERE receipt_code = $1`, [code]);
    if (taken.rowCount === 0) return code;
  }
  throw new AppError("INTERNAL", "Could not allocate a receipt code");
}

async function openShiftId(tx: TxHandle, registerId: string | null | undefined): Promise<string | null> {
  if (!registerId) return null;
  const shift = await tx.client.query<{ id: string }>(`SELECT id FROM shifts WHERE register_id = $1 AND status = 'open'`, [
    registerId,
  ]);
  return shift.rows[0]?.id ?? null;
}

export async function recordCashMovement(
  tx: TxHandle,
  ctx: Ctx,
  registerId: string | null | undefined,
  input: { kind: string; amountCents: number; orderId?: string | null; reason?: string | null },
) {
  const shiftId = await openShiftId(tx, registerId);
  if (!shiftId) return;
  await tx.client.query(
    `INSERT INTO cash_movements (tenant_id, shift_id, kind, amount_cents, order_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, shiftId, input.kind, input.amountCents, input.orderId ?? null, input.reason ?? null, ctx.userId],
  );
}

/**
 * Creates a sale order in the caller's transaction: prices it with the store's
 * tax rules, validates the tenders, writes lines/tax lines, moves stock,
 * records non-card payments as captured and card payments as intents with a
 * fixed externalRequestId (charged later via /payments/:id/confirm).
 */
export async function createSaleOrder(tx: TxHandle, ctx: Ctx, input: CreateOrderInput) {
  if (input.clientOrderId) {
    const dup = await tx.client.query<{ id: string }>(`SELECT id FROM orders WHERE client_order_id = $1`, [input.clientOrderId]);
    if (dup.rows[0]) throw new AppError("CONFLICT", "This sale was already recorded", { orderId: dup.rows[0].id });
  }

  const lineIds = input.lines.map(() => randomUUID());
  const totals = priceSale(
    input.lines.map((line, index) => ({
      lineId: lineIds[index]!,
      unitPriceCents: line.unitPriceCents,
      qty: line.qty,
      adjustCents: line.adjustCents ?? 0,
      taxCategory: line.taxCategory ?? null,
      ...(line.taxable === undefined ? {} : { taxable: line.taxable }),
    })),
    input.store.taxRules,
    { outOfState: Boolean(input.outOfState) },
  );

  const hasAccount = input.tenders.some((t) => t.method === "account");
  const customer = input.customerId ? await getCustomer(tx, input.customerId, { lock: hasAccount }) : null;
  const plan = planTenders({
    totalCents: totals.totalCents,
    tenders: input.tenders,
    collectLater: input.collectLater ?? null,
    customer: customer
      ? { id: customer.id, balanceCents: Number(customer.balance_cents), creditLimitCents: customer.credit_limit_cents }
      : null,
  });
  if (!plan.ok) throw new AppError("TENDER_INVALID", "The payment does not add up", { issues: plan.issues });

  const orderId = randomUUID();
  const receiptCode = await newReceiptCode(tx);
  await tx.client.query(
    `INSERT INTO orders (id, tenant_id, store_id, register_id, kind, status, receipt_code, customer_id, subtotal_cents,
                         tax_cents, total_cents, paid_cents, balance_due_date, tax_rate_ppm, tax_rules_snapshot, out_of_state,
                         notes, client_order_id, created_by)
     VALUES ($1,$2,$3,$4,'sale','awaiting_payment',$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16)`,
    [
      orderId,
      ctx.tenantId,
      input.store.id,
      input.registerId ?? null,
      receiptCode,
      customer?.id ?? null,
      totals.subtotalCents,
      totals.taxCents,
      totals.totalCents,
      input.collectLater?.dueDate ?? null,
      totals.tax.ratePpm,
      JSON.stringify(input.store.taxRules satisfies TaxRuleSet),
      Boolean(input.outOfState),
      input.notes ?? null,
      input.clientOrderId ?? null,
      ctx.userId,
    ],
  );

  for (const [index, line] of input.lines.entries()) {
    const priced = totals.lines[index]!;
    await tx.client.query(
      `INSERT INTO order_lines (id, tenant_id, order_id, kind, description, variant_id, serialized_unit_id, imei, work_order_id,
                                rental_contract_id, qty, unit_price_cents, adjust_cents, net_cents, tax_cents, tax_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        priced.lineId,
        ctx.tenantId,
        orderId,
        line.kind,
        line.description,
        line.variantId ?? null,
        line.serializedUnitId ?? null,
        line.imei ?? null,
        line.workOrderId ?? null,
        line.rentalContractId ?? null,
        line.qty,
        line.unitPriceCents,
        line.adjustCents ?? 0,
        priced.netCents,
        priced.taxCents,
        line.taxCategory ?? null,
      ],
    );
    const taxLine = totals.tax.lines[index]!;
    if (taxLine.taxableCents > 0 || taxLine.taxCents > 0) {
      await tx.client.query(
        `INSERT INTO tax_lines (tenant_id, order_id, order_line_id, jurisdiction, rate_ppm, taxable_cents, tax_cents, flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.tenantId, orderId, priced.lineId, input.store.code, totals.tax.ratePpm, taxLine.taxableCents, taxLine.taxCents, totals.tax.flags],
      );
    }
    if (line.moveStock && line.variantId) {
      await applyMovement(
        tx,
        ctx,
        {
          storeId: input.store.id,
          variantId: line.variantId,
          kind: "sale",
          qty: line.qty,
          serializedUnitId: line.serializedUnitId ?? null,
          sourceType: "order",
          sourceId: orderId,
        },
        { allowNegative: input.tenant.allowNegativeStock },
      );
    }
  }

  const pendingPaymentIds: string[] = [];
  for (const tender of input.tenders) {
    const paymentId = randomUUID();
    const isCard = tender.method === "card";
    await tx.client.query(
      `INSERT INTO payments (id, tenant_id, order_id, method, amount_cents, status, external_request_id, gateway, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        paymentId,
        ctx.tenantId,
        orderId,
        tender.method,
        tender.amountCents,
        isCard ? "requires_action" : "captured",
        isCard ? newExternalRequestId() : null,
        isCard ? "card_terminal" : null,
        ctx.userId,
      ],
    );
    if (isCard) pendingPaymentIds.push(paymentId);
    if (tender.method === "account" && customer) {
      await addLedgerEntry(tx, ctx, {
        customerId: customer.id,
        amountCents: -tender.amountCents,
        kind: "sale_on_account",
        orderId,
      });
    }
    if (tender.method === "cash") {
      await recordCashMovement(tx, ctx, input.registerId, { kind: "sale_cash", amountCents: tender.amountCents, orderId });
    }
  }

  await settleOrder(tx, ctx, orderId, input.tenant);

  if (input.collectLater && customer) {
    const balance = plan.balanceDueCents;
    await queueCustomerMessage(tx, ctx.tenantId, {
      dedupeKey: `order:${orderId}:reminder`,
      template: "payment_reminder",
      to: customer.phone,
      vars: { company: input.tenant.name, amount: formatMoney(balance, input.tenant.currency), companyPhone: input.tenant.company.phone },
      sendAt: reminderInstant(input.collectLater.dueDate, input.store.timeZone),
    });
  }

  return { orderId, pendingPaymentIds };
}

/** 10:00 local store time on the due date. */
export function reminderInstant(isoDate: string, timeZone: string): Date {
  return zonedTimeToUtc(isoDate, 10, 0, timeZone);
}

/**
 * Recompute what has been collected and move the order to its status. When an
 * order becomes fully paid, repairs on it are marked paid (with a "paid" text)
 * and any payment reminder still queued is cancelled.
 */
export async function settleOrder(tx: TxHandle, ctx: Ctx, orderId: string, tenant: TenantSettings): Promise<void> {
  const order = await tx.client.query<{ status: string; total_cents: number; balance_due_date: string | null; kind: string }>(
    `SELECT status, total_cents, balance_due_date, kind FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound("Order");
  if (row.kind !== "sale" || row.status === "voided") return;
  const sums = await tx.client.query<{ captured: number; pending: number }>(
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE status = 'captured'), 0)::int AS captured,
            count(*) FILTER (WHERE status IN ('requires_action','processing','pending_verification'))::int AS pending
       FROM payments WHERE order_id = $1`,
    [orderId],
  );
  const { captured, pending } = sums.rows[0]!;
  const status =
    captured >= row.total_cents ? "completed" : pending > 0 ? "awaiting_payment" : row.balance_due_date ? "balance_due" : "awaiting_payment";
  await tx.client.query(`UPDATE orders SET paid_cents = $2, status = $3, version = version + 1 WHERE id = $1`, [
    orderId,
    captured,
    status,
  ]);

  if (status === "completed" && row.status !== "completed") {
    await cancelPending(tx, `order:${orderId}:reminder`);
    // work_orders.paid_cents tracks the repair price (pre-tax) so it compares with the repair total.
    const repairs = await tx.client.query<{
      work_order_id: string;
      net: number;
      amount: number;
      phone: string | null;
      model: string;
      ticket: number;
    }>(
      `SELECT l.work_order_id, l.net_cents AS net, (l.net_cents + l.tax_cents)::int AS amount, w.customer_phone AS phone,
              w.model, w.ticket_number AS ticket
         FROM order_lines l JOIN work_orders w ON w.id = l.work_order_id
        WHERE l.order_id = $1 AND l.kind = 'work_order'`,
      [orderId],
    );
    for (const repair of repairs.rows) {
      await tx.client.query(`UPDATE work_orders SET paid_cents = paid_cents + $2, version = version + 1 WHERE id = $1`, [
        repair.work_order_id,
        repair.net,
      ]);
      await tx.client.query(
        `INSERT INTO work_order_events (tenant_id, work_order_id, kind, note, data, created_by)
         VALUES ($1,$2,'paid',NULL,$3,$4)`,
        [ctx.tenantId, repair.work_order_id, JSON.stringify({ orderId, netCents: repair.net, amountCents: repair.amount }), ctx.userId],
      );
      if (repair.phone) {
        await queueCustomerMessage(tx, ctx.tenantId, {
          dedupeKey: `wo:${repair.work_order_id}:paid:${orderId}`,
          template: "repair_paid",
          to: repair.phone,
          vars: { company: tenant.name, model: repair.model, ticket: String(repair.ticket) },
        });
      }
    }
  }
}

interface OrderRow {
  id: string;
  kind: "sale" | "return";
  status: "awaiting_payment" | "completed" | "balance_due" | "voided";
  receipt_code: string;
  store_id: string;
  customer_id: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_due_date: string | null;
  tax_rate_ppm: number;
  created_at: Date;
}

export async function loadOrder(tx: TxHandle, orderId: string) {
  const order = await tx.client.query<OrderRow>(
    `SELECT id, kind, status, receipt_code, store_id, customer_id, subtotal_cents, tax_cents, total_cents, paid_cents,
            balance_due_date, tax_rate_ppm, created_at FROM orders WHERE id = $1`,
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound("Order");
  const lines = await tx.client.query(
    `SELECT id, kind, description, variant_id, work_order_id, serialized_unit_id, imei, qty, returned_qty, unit_price_cents,
            net_cents, tax_cents FROM order_lines WHERE order_id = $1 ORDER BY id`,
    [orderId],
  );
  const payments = await tx.client.query(
    `SELECT id, order_id, method, amount_cents, refunded_cents, status, external_request_id, gateway_ref, card_summary
       FROM payments WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    receiptCode: row.receipt_code,
    storeId: row.store_id,
    customerId: row.customer_id,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    balanceDueCents: row.kind === "sale" && row.status !== "voided" ? Math.max(0, row.total_cents - row.paid_cents) : 0,
    balanceDueDate: row.balance_due_date,
    taxRatePpm: row.tax_rate_ppm,
    createdAt: row.created_at.toISOString(),
    lines: lines.rows.map((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      variantId: l.variant_id,
      workOrderId: l.work_order_id,
      serializedUnitId: l.serialized_unit_id,
      imei: l.imei,
      qty: l.qty,
      returnedQty: l.returned_qty,
      unitPriceCents: l.unit_price_cents,
      netCents: l.net_cents,
      taxCents: l.tax_cents,
    })),
    payments: payments.rows.map(toPaymentDto),
  };
}

export function toPaymentDto(p: {
  id: string;
  order_id: string;
  method: string;
  amount_cents: number;
  refunded_cents: number;
  status: string;
  external_request_id: string | null;
  gateway_ref: string | null;
  card_summary: string | null;
}) {
  return {
    id: p.id,
    orderId: p.order_id,
    method: p.method,
    amountCents: p.amount_cents,
    refundedCents: p.refunded_cents,
    status: p.status,
    externalRequestId: p.external_request_id,
    gatewayRef: p.gateway_ref,
    cardSummary: p.card_summary,
  };
}
