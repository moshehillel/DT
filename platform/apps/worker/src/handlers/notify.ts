import type { SendResult } from "@pos/adapters";
import { DEFAULT_TEMPLATES, renderTemplate, type NotificationTemplateKey } from "@pos/domain";
import { withTenant } from "@pos/db";
import type { TenantRef, WorkerDeps } from "../deps.js";
import type { ClaimedMessage, Outcome } from "../outbox.js";

interface NotifyPayload {
  template: NotificationTemplateKey;
  to: string;
  vars: Record<string, string | number | null>;
}

export async function handleNotification(deps: WorkerDeps, tenant: TenantRef, message: ClaimedMessage): Promise<Outcome> {
  const payload = message.payload as unknown as NotifyPayload;
  const channel = message.topic === "notify.voice" ? "voice" : "sms";
  const ctx = { tenantId: tenant.id };

  const prepared = await withTenant(deps.pool, ctx, async (tx) => {
    const prior = await tx.client.query<{ status: string }>(
      `SELECT status FROM notification_attempts WHERE outbox_id = $1 ORDER BY created_at DESC`,
      [message.id],
    );
    if (prior.rows.some((r) => r.status === "sent")) return { skip: { kind: "done", note: "already sent" } as Outcome };
    // A previous attempt started sending and never reported back (crash,
    // lease expiry, provider timeout). It may have been delivered.
    if (prior.rows.some((r) => r.status === "sending" || r.status === "unknown")) {
      return { skip: { kind: "review", error: "a previous send may have been delivered" } as Outcome };
    }
    const template = await tx.client.query<{ body: string }>(
      `SELECT body FROM notification_templates WHERE key = $1 AND channel IN ($2, 'sms') ORDER BY (channel = $2) DESC LIMIT 1`,
      [payload.template, channel],
    );
    const body = template.rows[0]?.body ?? DEFAULT_TEMPLATES[payload.template];
    if (!body) return { skip: { kind: "dead", error: `unknown template ${payload.template}` } as Outcome };
    const rendered = renderTemplate(body, payload.vars ?? {});
    if (!rendered.text) return { skip: { kind: "dead", error: "message rendered empty" } as Outcome };
    const attempt = await tx.client.query<{ id: string }>(
      `INSERT INTO notification_attempts (tenant_id, outbox_id, channel, to_address, body, provider, status)
       VALUES ($1,$2,$3,$4,$5,$6,'sending') RETURNING id`,
      [tenant.id, message.id, channel, payload.to, rendered.text, channel === "voice" ? "voice" : "sms"],
    );
    return { attemptId: attempt.rows[0]!.id, text: rendered.text };
  });
  if ("skip" in prepared) return prepared.skip!;

  let result: SendResult;
  try {
    result =
      channel === "voice"
        ? await (await deps.providers.voice(tenant)).call({ to: payload.to, say: prepared.text, idempotencyKey: message.id })
        : await (await deps.providers.sms(tenant)).sendSms({ to: payload.to, body: prepared.text, idempotencyKey: message.id });
  } catch (error) {
    // Provider construction failed (not configured): nothing was sent.
    result = { status: "failed", error: (error as Error).message, retryable: true };
  }

  const attemptStatus = result.status === "sent" ? "sent" : result.status === "unknown" ? "unknown" : "failed";
  await withTenant(deps.pool, ctx, (tx) =>
    tx.client.query(
      `UPDATE notification_attempts SET status = $2, provider_message_id = $3, error = $4, completed_at = now() WHERE id = $1`,
      [
        prepared.attemptId,
        attemptStatus,
        result.status === "sent" ? result.providerMessageId : null,
        result.status === "sent" ? null : result.error.slice(0, 500),
      ],
    ),
  );

  if (result.status === "sent") return { kind: "done" };
  if (result.status === "unknown") return { kind: "review", error: result.error };
  return result.retryable ? { kind: "retry", error: result.error } : { kind: "dead", error: result.error };
}
