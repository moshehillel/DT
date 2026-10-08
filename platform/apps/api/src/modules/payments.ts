import { randomUUID } from "node:crypto";
import type { ChargeOutcome } from "@pos/adapters";
import { CreatePaymentIntentCommand } from "@pos/contracts";
import { formatMoney } from "@pos/domain";
import { withTenant } from "@pos/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission, requireStoreAccess } from "../lib/auth.js";
import { command, idempotencyKeyFrom, writeAudit } from "../lib/command.js";
import type { Deps } from "../lib/deps.js";
import { AppError, notFound } from "../lib/errors.js";
import { loadOrder, newExternalRequestId, settleOrder, toPaymentDto } from "../services/orders.js";
import { loadTenant } from "../services/tenant.js";

interface PaymentRow {
  id: string;
  order_id: string;
  method: string;
  amount_cents: number;
  refunded_cents: number;
  status: string;
  external_request_id: string | null;
  gateway_ref: string | null;
  card_summary: string | null;
  manual_entry: boolean;
  store_id: string;
  order_register_id: string | null;
}

const SELECT_PAYMENT = `
  SELECT p.id, p.order_id, p.method, p.amount_cents, p.refunded_cents, p.status, p.external_request_id, p.gateway_ref,
         p.card_summary, p.manual_entry, o.store_id, o.register_id AS order_register_id
    FROM payments p JOIN orders o ON o.id = p.order_id`;

/**
 * Card payments are confirmed in three steps so the terminal is never called
 * inside a database transaction and never charged twice:
 *   1. lock the payment; requires_action -> processing (commit). Anything
 *      already processing / pending_verification is *queried*, not charged.
 *   2. call the gateway outside the transaction with the fixed externalRequestId.
 *   3. record the outcome: approved -> captured (order settles), declined ->
 *      declined, unknown -> pending_verification (the register shows
 *      "Verify" and the nightly reconciliation picks up anything left).
 */
async function confirmOrVerify(deps: Deps, request: FastifyRequest, reply: FastifyReply, mode: "confirm" | "verify") {
  const auth = request.auth;
  if (!auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
  requirePermission(auth, mode === "confirm" ? "payment.collect" : "payment.verify");
  idempotencyKeyFrom(request);
  const { id } = request.params as { id: string };
  const requestId = String(request.id);
  const tctx = { tenantId: auth.tenantId, userId: auth.userId };

  const step1 = await withTenant(deps.pool, tctx, async (tx) => {
    const result = await tx.client.query<PaymentRow>(`${SELECT_PAYMENT} WHERE p.id = $1 FOR UPDATE OF p`, [id]);
    const payment = result.rows[0];
    if (!payment) throw notFound("Payment");
    requireStoreAccess(auth, payment.store_id);
    if (payment.method !== "card" || !payment.external_request_id) {
      throw new AppError("PAYMENT_STATE_INVALID", "Only card payments are confirmed on a terminal");
    }
    if (payment.status === "requires_action" && mode === "confirm") {
      const registerId = auth.registerId ?? payment.order_register_id;
      const terminal = registerId
        ? await tx.client.query<{ terminal_device_id: string | null }>(`SELECT terminal_device_id FROM registers WHERE id = $1`, [
            registerId,
          ])
        : null;
      const deviceId = terminal?.rows[0]?.terminal_device_id;
      if (!deviceId) throw new AppError("PAYMENT_STATE_INVALID", "This register has no card terminal set up");
      await tx.client.query(
        `UPDATE payments SET status = 'processing', attempts = attempts + 1, terminal_id = $2, version = version + 1 WHERE id = $1`,
        [id, deviceId],
      );
      await writeAudit(tx, auth, requestId, request.ip ?? null, {
        action: "payment.charge_started",
        entityType: "payment",
        entityId: id,
        storeId: payment.store_id,
        data: { amountCents: payment.amount_cents, externalRequestId: payment.external_request_id, deviceId },
      });
      return { action: "charge" as const, payment, deviceId };
    }
    if (payment.status === "processing" || payment.status === "pending_verification") {
      return { action: "lookup" as const, payment, deviceId: null };
    }
    return { action: "none" as const, payment, deviceId: null };
  });

  if (step1.action === "none") return reply.send(toPaymentDto(step1.payment));

  const gateway = await deps.gatewayFor(auth.tenantId);
  let outcome: ChargeOutcome;
  try {
    outcome =
      step1.action === "charge"
        ? await gateway.charge({
            externalRequestId: step1.payment.external_request_id!,
            amountCents: step1.payment.amount_cents,
            deviceId: step1.deviceId!,
            manualEntry: step1.payment.manual_entry,
          })
        : await gateway.lookup(step1.payment.external_request_id!);
  } catch (error) {
    request.log.warn({ err: error, paymentId: id }, "gateway call threw; treating as unknown");
    outcome = { status: "unknown", message: "gateway error" };
  }

  const dto = await withTenant(deps.pool, tctx, async (tx) => {
    const tenant = await loadTenant(tx);
    let updated;
    if (outcome.status === "approved") {
      updated = await tx.client.query(
        `UPDATE payments SET status = 'captured', gateway_ref = $2, card_summary = $3, last_error = NULL, version = version + 1
          WHERE id = $1 AND status IN ('processing','pending_verification') RETURNING id`,
        [id, outcome.gatewayRef, outcome.cardSummary],
      );
    } else if (outcome.status === "declined") {
      updated = await tx.client.query(
        `UPDATE payments SET status = 'declined', last_error = $2, version = version + 1
          WHERE id = $1 AND status IN ('processing','pending_verification') RETURNING id`,
        [id, outcome.message],
      );
    } else {
      updated = await tx.client.query(
        `UPDATE payments SET status = 'pending_verification', last_error = $2, version = version + 1
          WHERE id = $1 AND status IN ('processing','pending_verification') RETURNING id`,
        [id, outcome.message],
      );
    }
    if (updated.rowCount) {
      await settleOrder(tx, tctx, step1.payment.order_id, tenant);
      await writeAudit(tx, auth, requestId, request.ip ?? null, {
        action: `payment.${mode}`,
        entityType: "payment",
        entityId: id,
        storeId: step1.payment.store_id,
        data: { outcome: outcome.status },
      });
    }
    const row = await tx.client.query<PaymentRow>(`${SELECT_PAYMENT} WHERE p.id = $1`, [id]);
    return toPaymentDto(row.rows[0]!);
  });
  return reply.send(dto);
}

export function registerPayments(app: FastifyInstance, deps: Deps) {
  app.post(
    "/api/v2/payments/intents",
    command(deps, { permission: "payment.collect", schema: CreatePaymentIntentCommand }, async ({ auth, tx }, body) => {
      const order = await tx.client.query<{ id: string; store_id: string; total_cents: number; status: string; kind: string }>(
        `SELECT id, store_id, total_cents, status, kind FROM orders WHERE id = $1 FOR UPDATE`,
        [body.orderId],
      );
      const row = order.rows[0];
      if (!row || row.kind !== "sale") throw notFound("Sale");
      requireStoreAccess(auth, row.store_id);
      if (row.status === "completed" || row.status === "voided") throw new AppError("CONFLICT", `This sale is ${row.status}`);
      const committed = await tx.client.query<{ sum: number }>(
        `SELECT coalesce(sum(amount_cents),0)::int AS sum FROM payments
          WHERE order_id = $1 AND status IN ('captured','requires_action','processing','pending_verification')`,
        [row.id],
      );
      const left = row.total_cents - committed.rows[0]!.sum;
      if (body.amountCents > left) throw new AppError("TENDER_INVALID", `Only ${formatMoney(left)} is left to pay`);
      const id = randomUUID();
      const inserted = await tx.client.query(
        `INSERT INTO payments (id, tenant_id, order_id, method, amount_cents, status, external_request_id, gateway, manual_entry, created_by)
         VALUES ($1,$2,$3,'card',$4,'requires_action',$5,'card_terminal',$6,$7)
         RETURNING id, order_id, method, amount_cents, refunded_cents, status, external_request_id, gateway_ref, card_summary`,
        [id, auth.tenantId, row.id, body.amountCents, newExternalRequestId(), body.manualEntry, auth.userId],
      );
      await settleOrder(tx, { tenantId: auth.tenantId, userId: auth.userId }, row.id, await loadTenant(tx));
      return {
        status: 201,
        body: toPaymentDto(inserted.rows[0]),
        audit: { action: "payment.intent", entityType: "payment", entityId: id, storeId: row.store_id, data: { amountCents: body.amountCents } },
      };
    }),
  );

  app.post("/api/v2/payments/:id/confirm", (request, reply) => confirmOrVerify(deps, request, reply, "confirm"));
  app.post("/api/v2/payments/:id/verify", (request, reply) => confirmOrVerify(deps, request, reply, "verify"));

  app.get("/api/v2/payments/:id", async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
    requirePermission(auth, "sale.read");
    const { id } = request.params as { id: string };
    const dto = await withTenant(deps.pool, { tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.client.query<PaymentRow>(`${SELECT_PAYMENT} WHERE p.id = $1`, [id]);
      if (!row.rows[0]) throw notFound("Payment");
      requireStoreAccess(auth, row.rows[0].store_id);
      return { payment: toPaymentDto(row.rows[0]), order: await loadOrder(tx, row.rows[0].order_id) };
    });
    return reply.send(dto);
  });
}
