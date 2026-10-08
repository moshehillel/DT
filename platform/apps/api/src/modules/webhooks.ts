import { escapeXml } from "@pos/adapters";
import { parseTicketInput, WORK_ORDER_STATUS_LABELS, type WorkOrderStatus } from "@pos/domain";
import { withAppRole, withTenant, type TxHandle } from "@pos/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Deps } from "../lib/deps.js";
import { AppError, notFound } from "../lib/errors.js";
import { enqueue } from "../lib/outbox.js";
import { verifyShopify, verifySharedToken, verifyTwilio } from "../lib/webhooks.js";

async function resolveTenant(deps: Deps, slug: string): Promise<string> {
  const id = await withAppRole(deps.pool, async (client) => {
    const result = await client.query<{ id: string | null }>(`SELECT app_tenant_by_slug($1) AS id`, [slug]);
    return result.rows[0]?.id ?? null;
  });
  if (!id) throw notFound("Shop");
  return id;
}

/** Store once per (provider, event id); returns false if this event was already received. */
async function recordEvent(tx: TxHandle, tenantId: string, provider: string, eventId: string, payload: unknown): Promise<boolean> {
  const result = await tx.client.query(
    `INSERT INTO webhook_events (tenant_id, provider, event_id, signature_valid, payload) VALUES ($1,$2,$3,true,$4)
     ON CONFLICT (tenant_id, provider, event_id) DO NOTHING`,
    [tenantId, provider, eventId, JSON.stringify(payload)],
  );
  return (result.rowCount ?? 0) > 0;
}

function twiml(reply: FastifyReply, body: string) {
  return reply.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

export function registerWebhooks(app: FastifyInstance, deps: Deps) {
  // Twilio IVR: caller keys in a 6-digit ticket and hears the repair status.
  app.post("/api/v2/webhooks/:tenant/twilio/voice", async (request: FastifyRequest, reply) => {
    const { tenant: slug } = request.params as { tenant: string };
    const tenantId = await resolveTenant(deps, slug);
    const token = await deps.secrets.get(slug, "TWILIO_AUTH_TOKEN");
    const params = (request.body ?? {}) as Record<string, string>;
    const url = `${deps.config.PUBLIC_BASE_URL.replace(/\/$/, "")}${request.url}`;
    if (!token || !verifyTwilio(token, url, params, request.headers["x-twilio-signature"] as string | undefined)) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid signature");
    }
    const digits = params.Digits;
    if (!digits) {
      return twiml(
        reply,
        `<Gather input="dtmf" numDigits="6" timeout="8" action="${escapeXml(request.url)}" method="POST"><Say>Please enter your six digit repair ticket number.</Say></Gather><Say>We did not receive a ticket number. Goodbye.</Say>`,
      );
    }
    const ticket = parseTicketInput(digits);
    const status = await withTenant(deps.pool, { tenantId }, async (tx) => {
      await recordEvent(tx, tenantId, "twilio_voice", `${params.CallSid ?? "call"}:${digits}`, { digits, from: params.From ?? null });
      if (!ticket) return null;
      const row = await tx.client.query<{ status: WorkOrderStatus; model: string }>(
        `SELECT status, model FROM work_orders WHERE ticket_number = $1
         UNION ALL SELECT w.status, w.model FROM work_orders w JOIN work_order_ticket_aliases a ON a.work_order_id = w.id WHERE a.alias = $2
         LIMIT 1`,
        [ticket, String(ticket)],
      );
      return row.rows[0] ?? null;
    });
    if (!status) return twiml(reply, `<Say>We could not find that ticket. Please call the store.</Say>`);
    return twiml(reply, `<Say>Your ${escapeXml(status.model)} repair status is ${escapeXml(WORK_ORDER_STATUS_LABELS[status.status])}.</Say>`);
  });

  app.post("/api/v2/webhooks/:tenant/shopify/orders", async (request, reply) => {
    const { tenant: slug } = request.params as { tenant: string };
    const tenantId = await resolveTenant(deps, slug);
    const secret = await deps.secrets.get(slug, "SHOPIFY_WEBHOOK_SECRET");
    if (!secret || !request.rawBody || !verifyShopify(secret, request.rawBody, request.headers["x-shopify-hmac-sha256"] as string | undefined)) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid signature");
    }
    const eventId = String(request.headers["x-shopify-webhook-id"] ?? (request.body as { id?: unknown })?.id ?? "");
    if (!eventId) throw new AppError("VALIDATION_FAILED", "Missing webhook id");
    const fresh = await withTenant(deps.pool, { tenantId }, async (tx) => {
      const isNew = await recordEvent(tx, tenantId, "shopify", eventId, request.body);
      if (isNew) await enqueue(tx, tenantId, { topic: "shopify.order", dedupeKey: `shopify:${eventId}`, payload: { eventId } });
      return isNew;
    });
    return reply.status(fresh ? 202 : 200).send({ received: true, duplicate: !fresh });
  });

  app.post("/api/v2/webhooks/:tenant/telebroad/calls", async (request, reply) => {
    const { tenant: slug } = request.params as { tenant: string };
    const tenantId = await resolveTenant(deps, slug);
    const expected = await deps.secrets.get(slug, "TELEBROAD_WEBHOOK_TOKEN");
    if (!expected || !verifySharedToken(expected, request.headers["x-webhook-token"] as string | undefined)) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid token");
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const eventId = String(body.callid ?? body.call_id ?? body.uniqueid ?? "");
    if (!eventId) throw new AppError("VALIDATION_FAILED", "Missing call id");
    const fresh = await withTenant(deps.pool, { tenantId }, async (tx) => {
      const isNew = await recordEvent(tx, tenantId, "telebroad", eventId, body);
      if (isNew) await enqueue(tx, tenantId, { topic: "telebroad.call", dedupeKey: `telebroad:${eventId}`, payload: { eventId } });
      return isNew;
    });
    return reply.status(fresh ? 202 : 200).send({ received: true, duplicate: !fresh });
  });
}
