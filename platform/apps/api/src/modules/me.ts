import { withTenant } from "@pos/db";
import type { FastifyInstance } from "fastify";
import { effective } from "../lib/auth.js";
import type { Deps } from "../lib/deps.js";
import { AppError } from "../lib/errors.js";
import { loadTenant } from "../services/tenant.js";

export function registerMe(app: FastifyInstance, deps: Deps) {
  app.get("/api/v2/me", async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
    const data = await withTenant(deps.pool, { tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const tenant = await loadTenant(tx);
      const scope = effective(auth).storeId;
      const stores = await tx.client.query<{
        id: string;
        name: string;
        code: string;
        address: string;
        phone: string;
        hours: string;
        time_zone: string;
        tax_rules: { ratePpm: number };
        tax_rate_needs_confirmation: boolean;
      }>(
        `SELECT id, name, code, address, phone, hours, time_zone, tax_rules, tax_rate_needs_confirmation
           FROM stores WHERE active ${scope ? "AND id = $1" : ""} ORDER BY name`,
        scope ? [scope] : [],
      );
      const registers = await tx.client.query<{ id: string; store_id: string; name: string; terminal: boolean }>(
        `SELECT id, store_id, name, terminal_device_id IS NOT NULL AS terminal FROM registers ORDER BY name`,
      );
      return {
        userId: auth.userId,
        displayName: auth.displayName,
        tenantId: auth.tenantId,
        tenantName: auth.tenantName,
        role: auth.member.role,
        operator: auth.operator ? { membershipId: auth.operator.membershipId, role: auth.operator.role, displayName: auth.operator.displayName } : null,
        memberships: [{ id: auth.member.membershipId, role: auth.member.role, storeId: auth.member.storeId }],
        company: { name: tenant.name, ...tenant.company, currency: tenant.currency },
        receiptNotes: tenant.receiptNotes,
        stores: stores.rows.map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          address: s.address,
          phone: s.phone,
          hours: s.hours,
          timeZone: s.time_zone,
          taxRatePpm: s.tax_rules.ratePpm,
          taxRateNeedsConfirmation: s.tax_rate_needs_confirmation,
          registers: registers.rows.filter((r) => r.store_id === s.id).map((r) => ({ id: r.id, name: r.name, hasTerminal: r.terminal })),
        })),
      };
    });
    return reply.send(data);
  });
}
