import { withAppRole, withTenant } from "@pos/db";
import { ProviderNotConfigured, type TenantRef, type WorkerDeps } from "./deps.js";
import { handleNotification } from "./handlers/notify.js";
import { handleRefund } from "./handlers/refund.js";
import { handleDepositRefund, handleRcukAdd } from "./handlers/rental.js";
import { handleInboundWebhook } from "./handlers/webhooks.js";

export interface ClaimedMessage {
  id: string;
  tenant_id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * What happened to a message:
 * - done: the effect happened (or had already happened).
 * - retry: it definitely did not happen; try again later with backoff.
 * - review: it may have happened (timeout after sending, crash mid-send).
 *   A person decides; the worker never repeats a possibly-delivered effect.
 * - dead: it definitely did not happen and retrying cannot help.
 */
export type Outcome =
  | { kind: "done"; note?: string }
  | { kind: "retry"; error: string }
  | { kind: "review"; error: string }
  | { kind: "dead"; error: string };

export type Handler = (deps: WorkerDeps, tenant: TenantRef, message: ClaimedMessage) => Promise<Outcome>;

const HANDLERS: Record<string, Handler> = {
  "notify.sms": handleNotification,
  "notify.voice": handleNotification,
  "payment.refund": handleRefund,
  "rental.rcuk_add": handleRcukAdd,
  "rental.deposit_refund": handleDepositRefund,
  "shopify.order": handleInboundWebhook,
  "telebroad.call": handleInboundWebhook,
};

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

/** Exponential backoff with full jitter: 30s, 1m, 2m, ... capped at 6h. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export async function processBatch(deps: WorkerDeps, opts: { limit?: number; leaseSeconds?: number } = {}): Promise<number> {
  const claimed = await withAppRole(deps.pool, async (client) => {
    const result = await client.query<ClaimedMessage>(`SELECT * FROM app_claim_outbox($1, $2)`, [opts.limit ?? 20, opts.leaseSeconds ?? 120]);
    return result.rows;
  });
  for (const message of claimed) await processOne(deps, message);
  return claimed.length;
}

async function processOne(deps: WorkerDeps, message: ClaimedMessage): Promise<void> {
  const log = { outboxId: message.id, tenantId: message.tenant_id, topic: message.topic, attempt: message.attempts };
  let outcome: Outcome;
  try {
    const slug = await withTenant(deps.pool, { tenantId: message.tenant_id }, async (tx) => {
      const row = await tx.client.query<{ slug: string }>(`SELECT slug FROM tenants LIMIT 1`);
      return row.rows[0]?.slug ?? "";
    });
    const handler = HANDLERS[message.topic];
    outcome = handler
      ? await handler(deps, { id: message.tenant_id, slug }, message)
      : { kind: "dead", error: `no handler for topic ${message.topic}` };
  } catch (error) {
    // Handlers record "about to send" before calling a provider, so an
    // exception that reaches here happened before anything left the building.
    const err = error as Error;
    outcome = { kind: "retry", error: err instanceof ProviderNotConfigured ? err.message : `${err.name}: ${err.message}` };
  }

  if (outcome.kind === "retry" && message.attempts >= message.max_attempts) {
    outcome = { kind: "dead", error: `gave up after ${message.attempts} attempts: ${outcome.error}` };
  }

  await withTenant(deps.pool, { tenantId: message.tenant_id }, async (tx) => {
    if (outcome.kind === "retry") {
      await tx.client.query(
        `UPDATE outbox SET status = 'pending', locked_until = NULL, last_error = $2,
                available_at = now() + make_interval(secs => $3::double precision / 1000)
          WHERE id = $1 AND status = 'processing'`,
        [message.id, outcome.error.slice(0, 1000), backoffMs(message.attempts)],
      );
    } else {
      const status = outcome.kind === "done" ? "done" : outcome.kind === "review" ? "needs_review" : "dead";
      const error = outcome.kind === "done" ? (outcome.note ?? null) : outcome.error.slice(0, 1000);
      await tx.client.query(
        `UPDATE outbox SET status = $2, locked_until = NULL, last_error = $3, processed_at = now()
          WHERE id = $1 AND status = 'processing'`,
        [message.id, status, error],
      );
    }
  });

  const level = outcome.kind === "done" ? "info" : outcome.kind === "retry" ? "warn" : "error";
  deps.log[level]({ ...log, outcome: outcome.kind, ...(outcome.kind !== "done" ? { error: outcome.error } : {}) }, "outbox message processed");
}
