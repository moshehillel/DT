import { randomUUID } from "node:crypto";
import { CreateSaleCommand, ReturnCommand, Tender } from "@pos/contracts";
import {
  CASHIER_REFUND_LIMIT_CENTS,
  formatMoney,
  normalizeImei,
  parsePriceAdjust,
  proportionalRefund,
  roleHas,
  StockRuleError,
} from "@pos/domain";
import type { TxHandle } from "@pos/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { effective, requireStoreAccess, type AuthContext } from "../lib/auth.js";
import { command, query } from "../lib/command.js";
import type { Deps } from "../lib/deps.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import { enqueue } from "../lib/outbox.js";
import { decodeCursor, pageLimit, toPage } from "../lib/pagination.js";
import { addLedgerEntry } from "../services/customers.js";
import { queueCustomerMessage } from "../services/notifications.js";
import {
  createSaleOrder,
  loadOrder,
  newExternalRequestId,
  recordCashMovement,
  settleOrder,
  type InternalLine,
} from "../services/orders.js";
import { applyMovement, transitionUnit } from "../services/stock.js";
import { loadStore, loadTenant, type StoreRow } from "../services/tenant.js";

type SaleLineInput = z.infer<typeof CreateSaleCommand>["lines"][number];

async function resolveLines(tx: TxHandle, auth: AuthContext, store: StoreRow, lines: SaleLineInput[]): Promise<InternalLine[]> {
  const role = effective(auth).role;
  const resolved: InternalLine[] = [];
  for (const line of lines) {
    if (line.kind === "custom") {
      resolved.push({
        kind: "custom",
        description: line.description,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
        taxable: line.taxable,
      });
      continue;
    }
    if (line.kind === "work_order") {
      const wo = await tx.client.query<{
        id: string;
        ticket_number: number;
        model: string;
        status: string;
        estimate_cents: number | null;
        final_price_cents: number | null;
        fixes: { priceCents: number }[];
        paid_cents: number;
      }>(
        `SELECT id, ticket_number, model, status, estimate_cents, final_price_cents, fixes, paid_cents
           FROM work_orders WHERE id = $1 FOR UPDATE`,
        [line.workOrderId],
      );
      const row = wo.rows[0];
      if (!row) throw notFound("Repair");
      if (row.status === "cancelled") throw new AppError("CONFLICT", "That repair was cancelled");
      const open = await tx.client.query(
        `SELECT 1 FROM order_lines l JOIN orders o ON o.id = l.order_id
          WHERE l.work_order_id = $1 AND o.status IN ('awaiting_payment','balance_due')`,
        [row.id],
      );
      if (open.rowCount) throw new AppError("CONFLICT", "This repair is already on an unpaid sale");
      const total = (row.final_price_cents ?? row.estimate_cents ?? 0) + row.fixes.reduce((s, f) => s + (f.priceCents ?? 0), 0);
      const outstanding = total - row.paid_cents;
      if (outstanding <= 0) throw new AppError("CONFLICT", "This repair is already paid");
      resolved.push({
        kind: "work_order",
        description: `Repair #${row.ticket_number} ${row.model}`,
        qty: 1,
        unitPriceCents: outstanding,
        taxCategory: "repair_service",
        workOrderId: row.id,
      });
      continue;
    }
    const variant = await tx.client.query<{
      id: string;
      name: string;
      price_cents: number;
      serialized: boolean;
      tax_category: string | null;
    }>(
      `SELECT v.id, v.name, v.price_cents, v.serialized, p.tax_category
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = $1 AND v.active AND p.active`,
      [line.variantId],
    );
    const v = variant.rows[0];
    if (!v) throw notFound("Product");
    if (line.unitPriceCents !== undefined && line.unitPriceCents !== v.price_cents && !roleHas(role, "catalog.write")) {
      throw forbidden("Only a manager can override a catalog price");
    }
    const base: InternalLine = {
      kind: "product",
      description: v.name,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents ?? v.price_cents,
      adjustCents: parsePriceAdjust(line.adjustCode),
      taxCategory: v.tax_category,
      variantId: v.id,
      moveStock: true,
    };
    if (v.serialized) {
      if (!line.imei) throw new AppError("VALIDATION_FAILED", `Scan the IMEI for ${v.name}`);
      if (line.qty !== 1) throw new AppError("VALIDATION_FAILED", "Each handset is its own line (qty 1)");
      let imei: string;
      try {
        imei = normalizeImei(line.imei);
      } catch (error) {
        throw new AppError("VALIDATION_FAILED", (error as StockRuleError).message);
      }
      const unit = await transitionUnit(tx, {
        imei,
        variantId: v.id,
        fromStatus: "in_stock",
        toStatus: "sold",
        fromStoreId: store.id,
      });
      resolved.push({ ...base, imei, serializedUnitId: unit.id });
    } else {
      if (line.imei) throw new AppError("VALIDATION_FAILED", `${v.name} is not tracked by IMEI`);
      resolved.push(base);
    }
  }
  return resolved;
}

export function registerSales(app: FastifyInstance, deps: Deps) {
  app.post(
    "/api/v2/sales",
    command(deps, { permission: "sale.create", schema: CreateSaleCommand }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.storeId);
      const [tenant, store] = await Promise.all([loadTenant(tx), loadStore(tx, body.storeId)]);
      const lines = await resolveLines(tx, auth, store, body.lines);
      const { orderId, pendingPaymentIds } = await createSaleOrder(
        tx,
        { tenantId: auth.tenantId, userId: auth.userId },
        {
          store,
          tenant,
          registerId: body.registerId ?? null,
          customerId: body.customerId ?? null,
          lines,
          tenders: body.tenders,
          collectLater: body.collectLater ?? null,
          outOfState: body.outOfState,
          notes: body.notes ?? null,
          clientOrderId: body.clientOrderId ?? null,
        },
      );
      const order = await loadOrder(tx, orderId);
      return {
        status: 201,
        body: { order, pendingPayments: order.payments.filter((p) => pendingPaymentIds.includes(p.id)) },
        audit: {
          action: "sale.create",
          entityType: "order",
          entityId: orderId,
          storeId: store.id,
          data: { totalCents: order.totalCents, tenders: body.tenders, lines: body.lines.length },
        },
      };
    }),
  );

  app.get(
    "/api/v2/sales",
    query<Record<string, string>, { storeId?: string; cursor?: string; limit?: string; status?: string }>(
      deps,
      "sale.read",
      async ({ auth, tx, query: q }) => {
        const scope = effective(auth).storeId;
        const params: unknown[] = [];
        const where: string[] = [];
        const storeId = scope ?? q.storeId;
        if (storeId) {
          params.push(storeId);
          where.push(`store_id = $${params.length}`);
        }
        if (q.status) {
          params.push(q.status);
          where.push(`status = $${params.length}`);
        }
        const cursor = decodeCursor(q.cursor);
        if (cursor) {
          params.push(cursor.createdAt, cursor.id);
          where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        const limit = pageLimit(q.limit);
        params.push(limit + 1);
        const rows = await tx.client.query<{
          id: string;
          created_at: Date;
          kind: string;
          status: string;
          receipt_code: string;
          total_cents: number;
          paid_cents: number;
          customer_id: string | null;
          store_id: string;
        }>(
          `SELECT id, created_at, kind, status, receipt_code, total_cents, paid_cents, customer_id, store_id FROM orders
            ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
          params,
        );
        return toPage(rows.rows, limit, (r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          receiptCode: r.receipt_code,
          totalCents: r.total_cents,
          paidCents: r.paid_cents,
          customerId: r.customer_id,
          storeId: r.store_id,
          createdAt: r.created_at.toISOString(),
        }));
      },
    ),
  );

  app.get(
    "/api/v2/sales/:id",
    query<{ id: string }>(deps, "sale.read", async ({ auth, tx, params }) => {
      const order = await loadOrder(tx, params.id);
      requireStoreAccess(auth, order.storeId);
      return order;
    }),
  );

  app.get(
    "/api/v2/sales/by-receipt/:code",
    query<{ code: string }>(deps, "sale.read", async ({ auth, tx, params }) => {
      const row = await tx.client.query<{ id: string }>(`SELECT id FROM orders WHERE receipt_code = $1`, [
        params.code.toUpperCase(),
      ]);
      if (!row.rows[0]) throw notFound("Receipt");
      const order = await loadOrder(tx, row.rows[0].id);
      requireStoreAccess(auth, order.storeId);
      return order;
    }),
  );

  app.post(
    "/api/v2/sales/:id/payments",
    command<z.ZodObject<{ tenders: z.ZodArray<typeof Tender> }>, { id: string }>(
      deps,
      { permission: "payment.collect", schema: z.object({ tenders: z.array(Tender).min(1).max(4) }) },
      async ({ auth, tx, params }, body) => {
        const tenant = await loadTenant(tx);
        const order = await tx.client.query<{
          id: string;
          store_id: string;
          customer_id: string | null;
          total_cents: number;
          status: string;
          register_id: string | null;
          kind: string;
        }>(`SELECT id, store_id, customer_id, total_cents, status, register_id, kind FROM orders WHERE id = $1 FOR UPDATE`, [
          params.id,
        ]);
        const row = order.rows[0];
        if (!row || row.kind !== "sale") throw notFound("Sale");
        requireStoreAccess(auth, row.store_id);
        if (row.status === "completed" || row.status === "voided") throw new AppError("CONFLICT", `This sale is ${row.status}`);
        const open = await tx.client.query<{ committed: number }>(
          `SELECT coalesce(sum(amount_cents), 0)::int AS committed FROM payments
            WHERE order_id = $1 AND status IN ('captured','requires_action','processing','pending_verification')`,
          [row.id],
        );
        const outstanding = row.total_cents - open.rows[0]!.committed;
        const tendered = body.tenders.reduce((s, t) => s + t.amountCents, 0);
        if (tendered > outstanding) throw new AppError("TENDER_INVALID", `Only ${formatMoney(outstanding)} is left to pay`);
        const ctx = { tenantId: auth.tenantId, userId: auth.userId };
        const pending: string[] = [];
        for (const tender of body.tenders) {
          if (tender.method === "account") {
            if (!row.customer_id) throw new AppError("TENDER_INVALID", "Paying on account needs a customer on the sale");
            await tx.client.query(`SELECT 1 FROM customers WHERE id = $1 FOR UPDATE`, [row.customer_id]);
            const balance = await tx.client.query<{ balance: number; limit: number }>(
              `SELECT coalesce((SELECT sum(amount_cents) FROM customer_ledger_entries WHERE customer_id = c.id),0)::int AS balance,
                      c.credit_limit_cents AS limit FROM customers c WHERE c.id = $1`,
              [row.customer_id],
            );
            const b = balance.rows[0]!;
            if (b.balance - tender.amountCents < -b.limit) throw new AppError("TENDER_INVALID", "Over the customer's credit limit");
            await addLedgerEntry(tx, ctx, { customerId: row.customer_id, amountCents: -tender.amountCents, kind: "sale_on_account", orderId: row.id });
          }
          const isCard = tender.method === "card";
          const id = randomUUID();
          await tx.client.query(
            `INSERT INTO payments (id, tenant_id, order_id, method, amount_cents, status, external_request_id, gateway, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              id,
              auth.tenantId,
              row.id,
              tender.method,
              tender.amountCents,
              isCard ? "requires_action" : "captured",
              isCard ? newExternalRequestId() : null,
              isCard ? "card_terminal" : null,
              auth.userId,
            ],
          );
          if (isCard) pending.push(id);
          if (tender.method === "cash") {
            await recordCashMovement(tx, ctx, auth.registerId ?? row.register_id, {
              kind: "sale_cash",
              amountCents: tender.amountCents,
              orderId: row.id,
            });
          }
        }
        await settleOrder(tx, ctx, row.id, tenant);
        const dto = await loadOrder(tx, row.id);
        return {
          status: 200,
          body: { order: dto, pendingPayments: dto.payments.filter((p) => pending.includes(p.id)) },
          audit: { action: "sale.collect", entityType: "order", entityId: row.id, storeId: row.store_id, data: { tenders: body.tenders } },
        };
      },
    ),
  );

  app.post(
    "/api/v2/sales/:id/payment-request",
    command<z.ZodObject<Record<string, never>>, { id: string }>(
      deps,
      { permission: "payment.collect", schema: z.object({}) },
      async ({ auth, tx, params, requestId }) => {
        const tenant = await loadTenant(tx);
        const order = await loadOrder(tx, params.id);
        requireStoreAccess(auth, order.storeId);
        if (!order.customerId) throw new AppError("VALIDATION_FAILED", "Add the customer's phone to the sale first");
        if (order.balanceDueCents <= 0) throw new AppError("CONFLICT", "Nothing is owed on this sale");
        const customer = await tx.client.query<{ phone: string }>(`SELECT phone FROM customers WHERE id = $1`, [order.customerId]);
        await queueCustomerMessage(tx, auth.tenantId, {
          dedupeKey: `order:${order.id}:payreq:${requestId}`,
          template: "payment_request",
          to: customer.rows[0]!.phone,
          vars: { company: tenant.name, amount: formatMoney(order.balanceDueCents, tenant.currency), companyPhone: tenant.company.phone },
        });
        return {
          status: 202,
          body: { queued: true },
          audit: { action: "sale.payment_request", entityType: "order", entityId: order.id, storeId: order.storeId },
        };
      },
    ),
  );

  app.post(
    "/api/v2/sales/:id/void",
    command<z.ZodObject<{ reason: z.ZodString }>, { id: string }>(
      deps,
      { permission: "sale.return", schema: z.object({ reason: z.string().trim().min(2).max(300) }) },
      async ({ auth, tx, params }, body) => {
        const tenant = await loadTenant(tx);
        const order = await tx.client.query<{ id: string; store_id: string; status: string; kind: string }>(
          `SELECT id, store_id, status, kind FROM orders WHERE id = $1 FOR UPDATE`,
          [params.id],
        );
        const row = order.rows[0];
        if (!row || row.kind !== "sale") throw notFound("Sale");
        requireStoreAccess(auth, row.store_id);
        const payments = await tx.client.query<{ status: string }>(`SELECT status FROM payments WHERE order_id = $1`, [row.id]);
        if (payments.rows.some((p) => p.status === "captured")) {
          throw new AppError("PAYMENT_STATE_INVALID", "Money was already taken on this sale — use a return instead");
        }
        if (payments.rows.some((p) => p.status === "processing" || p.status === "pending_verification")) {
          throw new AppError("PAYMENT_STATE_INVALID", "A card payment is still being verified — verify it before voiding");
        }
        await tx.client.query(`UPDATE payments SET status = 'voided', version = version + 1 WHERE order_id = $1 AND status = 'requires_action'`, [
          row.id,
        ]);
        const lines = await tx.client.query<{ variant_id: string | null; qty: number; imei: string | null; serialized_unit_id: string | null }>(
          `SELECT variant_id, qty, imei, serialized_unit_id FROM order_lines WHERE order_id = $1 AND kind = 'product'`,
          [row.id],
        );
        const ctx = { tenantId: auth.tenantId, userId: auth.userId };
        for (const line of lines.rows) {
          if (!line.variant_id) continue;
          if (line.imei) {
            await transitionUnit(tx, { imei: line.imei, fromStatus: "sold", toStatus: "in_stock", toStoreId: row.store_id });
          }
          await applyMovement(
            tx,
            ctx,
            {
              storeId: row.store_id,
              variantId: line.variant_id,
              kind: "return",
              qty: line.qty,
              serializedUnitId: line.serialized_unit_id,
              sourceType: "order_void",
              sourceId: row.id,
            },
            { allowNegative: tenant.allowNegativeStock },
          );
        }
        await tx.client.query(`UPDATE orders SET status = 'voided', version = version + 1 WHERE id = $1`, [row.id]);
        return {
          status: 200,
          body: await loadOrder(tx, row.id),
          audit: { action: "sale.void", entityType: "order", entityId: row.id, storeId: row.store_id, data: { reason: body.reason } },
        };
      },
    ),
  );

  app.post(
    "/api/v2/sales/:id/returns",
    command<typeof ReturnCommand, { id: string }>(
      deps,
      { permission: "sale.return", schema: ReturnCommand },
      async ({ auth, tx, params }, body) => {
        const tenant = await loadTenant(tx);
        const original = await tx.client.query<{
          id: string;
          store_id: string;
          kind: string;
          status: string;
          customer_id: string | null;
          tax_rate_ppm: number;
          tax_rules_snapshot: unknown;
          register_id: string | null;
        }>(
          `SELECT id, store_id, kind, status, customer_id, tax_rate_ppm, tax_rules_snapshot, register_id FROM orders WHERE id = $1`,
          [params.id],
        );
        const order = original.rows[0];
        if (!order || order.kind !== "sale") throw notFound("Sale");
        requireStoreAccess(auth, order.store_id);
        if (order.status === "voided") throw new AppError("CONFLICT", "This sale was voided");
        const ctx = { tenantId: auth.tenantId, userId: auth.userId };

        const returnOrderId = randomUUID();
        const returnLines: {
          originalLineId: string;
          kind: string;
          description: string;
          variantId: string | null;
          serializedUnitId: string | null;
          imei: string | null;
          qty: number;
          unitPriceCents: number;
          netCents: number;
          taxCents: number;
          restock: boolean;
        }[] = [];

        for (const requested of body.lines) {
          // Atomic cap: two registers returning the same line cannot both succeed past the sold qty.
          const line = await tx.client.query<{
            id: string;
            kind: string;
            description: string;
            variant_id: string | null;
            serialized_unit_id: string | null;
            imei: string | null;
            qty: number;
            returned_qty: number;
            net_cents: number;
            tax_cents: number;
            refunded_net_cents: number;
            refunded_tax_cents: number;
            unit_price_cents: number;
            adjust_cents: number;
          }>(
            `UPDATE order_lines SET returned_qty = returned_qty + $3
              WHERE id = $1 AND order_id = $2 AND returned_qty + $3 <= qty
              RETURNING id, kind, description, variant_id, serialized_unit_id, imei, qty, returned_qty - $3 AS returned_qty,
                        net_cents, tax_cents, refunded_net_cents, refunded_tax_cents, unit_price_cents, adjust_cents`,
            [requested.orderLineId, order.id, requested.qty],
          );
          const l = line.rows[0];
          if (!l) throw new AppError("RETURN_EXCEEDS_SOLD", "That line was already returned or is not on this sale");
          if (l.kind === "work_order" || l.kind === "deposit") {
            throw new AppError("VALIDATION_FAILED", "Repairs and deposits are refunded from their own screens");
          }
          const netRefund = proportionalRefund({
            originalCents: l.net_cents,
            originalQty: l.qty,
            alreadyReturnedQty: l.returned_qty,
            alreadyRefundedCents: l.refunded_net_cents,
            returnQty: requested.qty,
          });
          const taxRefund = proportionalRefund({
            originalCents: l.tax_cents,
            originalQty: l.qty,
            alreadyReturnedQty: l.returned_qty,
            alreadyRefundedCents: l.refunded_tax_cents,
            returnQty: requested.qty,
          });
          await tx.client.query(
            `UPDATE order_lines SET refunded_net_cents = refunded_net_cents + $2, refunded_tax_cents = refunded_tax_cents + $3 WHERE id = $1`,
            [l.id, netRefund, taxRefund],
          );
          returnLines.push({
            originalLineId: l.id,
            kind: l.kind,
            description: l.description,
            variantId: l.variant_id,
            serializedUnitId: l.serialized_unit_id,
            imei: l.imei,
            qty: requested.qty,
            unitPriceCents: Math.max(0, l.unit_price_cents + l.adjust_cents),
            netCents: netRefund,
            taxCents: taxRefund,
            restock: requested.restock,
          });
        }

        const subtotal = returnLines.reduce((s, l) => s + l.netCents, 0);
        const tax = returnLines.reduce((s, l) => s + l.taxCents, 0);
        const total = subtotal + tax;
        const allocated = body.refunds.reduce((s, r) => s + r.amountCents, 0);
        if (allocated !== total) {
          throw new AppError("TENDER_INVALID", `Refunds must add up to ${formatMoney(total)}`, { refundTotalCents: total });
        }
        if (total > CASHIER_REFUND_LIMIT_CENTS && !roleHas(effective(auth).role, "payment.refund_over_limit")) {
          throw forbidden(`Refunds over ${formatMoney(CASHIER_REFUND_LIMIT_CENTS)} need a manager`);
        }

        await tx.client.query(
          `INSERT INTO orders (id, tenant_id, store_id, register_id, kind, original_order_id, status, receipt_code, customer_id,
                               subtotal_cents, tax_cents, total_cents, paid_cents, tax_rate_ppm, tax_rules_snapshot, notes, created_by)
           VALUES ($1,$2,$3,$4,'return',$5,'completed',$6,$7,$8,$9,$10,$10,$11,$12,$13,$14)`,
          [
            returnOrderId,
            auth.tenantId,
            order.store_id,
            body.registerId ?? auth.registerId ?? null,
            order.id,
            `R${returnOrderId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
            order.customer_id,
            subtotal,
            tax,
            total,
            order.tax_rate_ppm,
            JSON.stringify(order.tax_rules_snapshot),
            body.reason,
            auth.userId,
          ],
        );

        for (const l of returnLines) {
          await tx.client.query(
            `INSERT INTO order_lines (tenant_id, order_id, kind, description, variant_id, serialized_unit_id, imei, original_line_id,
                                      qty, unit_price_cents, net_cents, tax_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              auth.tenantId,
              returnOrderId,
              l.kind,
              l.description,
              l.variantId,
              l.serializedUnitId,
              l.imei,
              l.originalLineId,
              l.qty,
              l.unitPriceCents,
              l.netCents,
              l.taxCents,
            ],
          );
          if (l.restock && l.variantId) {
            if (l.imei) {
              await transitionUnit(tx, { imei: l.imei, fromStatus: "sold", toStatus: "in_stock", toStoreId: order.store_id });
            }
            await applyMovement(
              tx,
              ctx,
              {
                storeId: order.store_id,
                variantId: l.variantId,
                kind: "return",
                qty: l.qty,
                serializedUnitId: l.serializedUnitId,
                sourceType: "return",
                sourceId: returnOrderId,
              },
              { allowNegative: tenant.allowNegativeStock },
            );
          }
        }

        for (const refund of body.refunds) {
          // The cap lives in the database: the WHERE clause and the CHECK
          // constraint mean concurrent refunds can never exceed the payment.
          const capped = await tx.client.query<{ id: string; method: string; gateway_ref: string | null }>(
            `UPDATE payments SET refunded_cents = refunded_cents + $3, version = version + 1
              WHERE id = $1 AND order_id = $2 AND status = 'captured' AND refunded_cents + $3 <= amount_cents
              RETURNING id, method, gateway_ref`,
            [refund.paymentId, order.id, refund.amountCents],
          );
          const payment = capped.rows[0];
          if (!payment) throw new AppError("REFUND_EXCEEDS_PAYMENT", "That refund is more than is left on the original payment");
          const refundId = randomUUID();
          const isCard = payment.method === "card";
          await tx.client.query(
            `INSERT INTO refunds (id, tenant_id, payment_id, return_order_id, amount_cents, status, external_request_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [refundId, auth.tenantId, payment.id, returnOrderId, refund.amountCents, isCard ? "pending" : "succeeded", isCard ? newExternalRequestId() : null, auth.userId],
          );
          if (isCard) {
            await enqueue(tx, auth.tenantId, { topic: "payment.refund", dedupeKey: `refund:${refundId}`, payload: { refundId } });
          } else if (payment.method === "account" && order.customer_id) {
            await addLedgerEntry(tx, ctx, {
              customerId: order.customer_id,
              amountCents: refund.amountCents,
              kind: "refund_to_account",
              orderId: returnOrderId,
            });
          } else if (payment.method === "cash") {
            await recordCashMovement(tx, ctx, body.registerId ?? auth.registerId ?? order.register_id, {
              kind: "refund_cash",
              amountCents: -refund.amountCents,
              orderId: returnOrderId,
            });
          }
        }

        return {
          status: 201,
          body: { order: await loadOrder(tx, returnOrderId) },
          audit: {
            action: "sale.return",
            entityType: "order",
            entityId: returnOrderId,
            storeId: order.store_id,
            data: { originalOrderId: order.id, totalCents: total, reason: body.reason },
          },
        };
      },
    ),
  );
}
