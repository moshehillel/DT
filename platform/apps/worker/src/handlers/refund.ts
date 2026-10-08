import type { RefundOutcome } from "@pos/adapters";
import { withTenant } from "@pos/db";
import type { TenantRef, WorkerDeps } from "../deps.js";
import type { ClaimedMessage, Outcome } from "../outbox.js";

/**
 * Card refunds. The refund row was created (and the payment's refund cap
 * reserved) in the API transaction; this sends it to the gateway exactly
 * once. pending -> processing is committed before the gateway call, so a
 * refund found in "processing" is never sent again automatically.
 */
export async function handleRefund(deps: WorkerDeps, tenant: TenantRef, message: ClaimedMessage): Promise<Outcome> {
  const { refundId } = message.payload as { refundId: string };
  const ctx = { tenantId: tenant.id };

  const claim = await withTenant(deps.pool, ctx, async (tx) => {
    const row = await tx.client.query<{
      status: string;
      amount_cents: number;
      external_request_id: string | null;
      gateway_ref: string | null;
    }>(
      `SELECT r.status, r.amount_cents, r.external_request_id, p.gateway_ref
         FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1 FOR UPDATE OF r`,
      [refundId],
    );
    const refund = row.rows[0];
    if (!refund) return { outcome: { kind: "dead", error: "refund not found" } as Outcome };
    if (refund.status === "succeeded") return { outcome: { kind: "done", note: "already refunded" } as Outcome };
    if (refund.status === "processing" || refund.status === "needs_review") {
      await tx.client.query(`UPDATE refunds SET status = 'needs_review' WHERE id = $1`, [refundId]);
      return { outcome: { kind: "review", error: "a previous refund attempt may have gone through" } as Outcome };
    }
    if (refund.status !== "pending") return { outcome: { kind: "done", note: `refund is ${refund.status}` } as Outcome };
    if (!refund.gateway_ref || !refund.external_request_id) {
      await tx.client.query(`UPDATE refunds SET status = 'needs_review' WHERE id = $1`, [refundId]);
      return { outcome: { kind: "review", error: "original card payment has no gateway reference" } as Outcome };
    }
    await tx.client.query(`UPDATE refunds SET status = 'processing' WHERE id = $1`, [refundId]);
    return { refund };
  });
  if (claim.outcome) return claim.outcome;
  const refund = claim.refund!;

  let result: RefundOutcome;
  try {
    const gateway = await deps.providers.gateway(tenant);
    result = await gateway.refund({
      externalRequestId: refund.external_request_id!,
      gatewayRef: refund.gateway_ref!,
      amountCents: refund.amount_cents,
    });
  } catch (error) {
    result = { status: "unknown", message: (error as Error).message };
  }

  return withTenant(deps.pool, ctx, async (tx): Promise<Outcome> => {
    if (result.status === "approved") {
      await tx.client.query(`UPDATE refunds SET status = 'succeeded', gateway_ref = $2 WHERE id = $1`, [refundId, result.gatewayRef]);
      return { kind: "done" };
    }
    // Declined or unknown: the customer has not (knowingly) been paid back.
    // A manager must see it — refund another way or retry deliberately.
    await tx.client.query(`UPDATE refunds SET status = $2 WHERE id = $1`, [refundId, result.status === "declined" ? "failed" : "needs_review"]);
    return { kind: "review", error: `refund ${result.status}: ${result.message}` };
  });
}
