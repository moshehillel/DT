import { withTenant } from "@pos/db";
import type { TenantRef, WorkerDeps } from "../deps.js";
import type { ClaimedMessage, Outcome } from "../outbox.js";

/**
 * Shopify orders and Telebroad call events are stored and acknowledged by the
 * API. Turning them into POS orders / caller pop-ups is not built yet; the
 * event is marked so nothing is lost and it can be replayed once it is.
 */
export async function handleInboundWebhook(deps: WorkerDeps, tenant: TenantRef, message: ClaimedMessage): Promise<Outcome> {
  const provider = message.topic === "shopify.order" ? "shopify" : "telebroad";
  const { eventId } = message.payload as { eventId: string };
  await withTenant(deps.pool, { tenantId: tenant.id }, (tx) =>
    tx.client.query(
      `UPDATE webhook_events SET status = 'stored_unprocessed', processed_at = now() WHERE provider = $1 AND event_id = $2`,
      [provider, eventId],
    ),
  );
  return { kind: "done", note: "stub: stored for later processing" };
}
