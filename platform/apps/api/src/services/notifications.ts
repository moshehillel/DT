import type { NotificationTemplateKey } from "@pos/domain";
import type { TxHandle } from "@pos/db";
import { enqueue } from "../lib/outbox.js";

/**
 * Customer messages are queued with a template key and variables, and
 * rendered by the worker at send time from the tenant's own templates.
 */
export async function queueCustomerMessage(
  tx: TxHandle,
  tenantId: string,
  input: {
    dedupeKey: string;
    template: NotificationTemplateKey;
    to: string;
    vars: Record<string, string | number | null>;
    channel?: "sms" | "voice" | "both";
    sendAt?: Date;
  },
): Promise<string | null> {
  const channel = input.channel ?? "sms";
  const payload = { template: input.template, to: input.to, vars: input.vars };
  let first: string | null = null;
  if (channel === "sms" || channel === "both") {
    first = await enqueue(tx, tenantId, {
      topic: "notify.sms",
      dedupeKey: `${input.dedupeKey}:sms`,
      payload,
      ...(input.sendAt ? { availableAt: input.sendAt } : {}),
    });
  }
  if (channel === "voice" || channel === "both") {
    const id = await enqueue(tx, tenantId, {
      topic: "notify.voice",
      dedupeKey: `${input.dedupeKey}:voice`,
      payload,
      ...(input.sendAt ? { availableAt: input.sendAt } : {}),
    });
    first ??= id;
  }
  return first;
}
