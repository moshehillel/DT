import type { TxHandle } from "@pos/db";

export type OutboxTopic =
  | "notify.sms"
  | "notify.voice"
  | "payment.refund"
  | "rental.rcuk_add"
  | "rental.deposit_refund"
  | "shopify.order"
  | "telebroad.call";

/**
 * Enqueue a side effect in the same transaction as the business change. The
 * dedupe key makes it one message per business event: a replayed request or a
 * repeated status change cannot queue a second text.
 */
export async function enqueue(
  tx: TxHandle,
  tenantId: string,
  input: { topic: OutboxTopic; dedupeKey: string; payload: Record<string, unknown>; availableAt?: Date },
): Promise<string | null> {
  const result = await tx.client.query<{ id: string }>(
    `INSERT INTO outbox (tenant_id, topic, dedupe_key, payload, available_at)
     VALUES ($1,$2,$3,$4, coalesce($5, now()))
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
    [tenantId, input.topic, input.dedupeKey, JSON.stringify(input.payload), input.availableAt ?? null],
  );
  return result.rows[0]?.id ?? null;
}

/** Cancel queued-but-unsent messages (e.g. a scheduled "ready" text when the repair goes back to in_repair). */
export async function cancelPending(tx: TxHandle, dedupePrefix: string): Promise<number> {
  const result = await tx.client.query(
    `UPDATE outbox SET status = 'cancelled', processed_at = now()
      WHERE status = 'pending' AND dedupe_key LIKE $1`,
    [`${dedupePrefix.replace(/[%_]/g, "\\$&")}%`],
  );
  return result.rowCount ?? 0;
}
