import { randomUUID } from "node:crypto";
import { LedgerAdjustCommand, UpsertCustomerCommand } from "@pos/contracts";
import type { FastifyInstance } from "fastify";
import { command, query } from "../lib/command.js";
import type { Deps } from "../lib/deps.js";
import { decodeCursor, pageLimit, toPage } from "../lib/pagination.js";
import { addLedgerEntry, getCustomer, searchCustomers, toCustomerDto, upsertCustomer } from "../services/customers.js";
import { loadTenant } from "../services/tenant.js";

export function registerCustomers(app: FastifyInstance, deps: Deps) {
  app.post(
    "/api/v2/customers",
    command(deps, { permission: "customer.write", schema: UpsertCustomerCommand }, async ({ auth, tx }, body) => {
      const tenant = await loadTenant(tx);
      const row = await upsertCustomer(
        tx,
        { tenantId: auth.tenantId, userId: auth.userId, defaultCreditLimitCents: tenant.defaultCreditLimitCents },
        body,
      );
      return {
        status: 200,
        body: toCustomerDto(row),
        audit: { action: "customer.upsert", entityType: "customer", entityId: row.id, data: { fields: Object.keys(body) } },
      };
    }),
  );

  app.get(
    "/api/v2/customers",
    query<Record<string, string>, { q?: string; cursor?: string; limit?: string }>(deps, "customer.read", async ({ tx, query: q }) => {
      const limit = pageLimit(q.limit);
      const rows = await searchCustomers(tx, q.q ?? "", limit, decodeCursor(q.cursor));
      return toPage(rows.rows, limit, toCustomerDto);
    }),
  );

  app.get(
    "/api/v2/customers/:id",
    query<{ id: string }>(deps, "customer.read", async ({ tx, params }) => toCustomerDto(await getCustomer(tx, params.id))),
  );

  app.get(
    "/api/v2/customers/:id/ledger",
    query<{ id: string }, { cursor?: string; limit?: string }>(deps, "customer.read", async ({ tx, params, query: q }) => {
      const limit = pageLimit(q.limit);
      const cursor = decodeCursor(q.cursor);
      const values: unknown[] = [params.id];
      let where = "customer_id = $1";
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        where += ` AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
      }
      values.push(limit + 1);
      const rows = await tx.client.query(
        `SELECT id, amount_cents, kind, reason, order_id, created_at FROM customer_ledger_entries
          WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      return toPage(rows.rows, limit, (r) => ({
        id: r.id,
        amountCents: r.amount_cents,
        kind: r.kind,
        reason: r.reason,
        orderId: r.order_id,
        createdAt: r.created_at.toISOString(),
      }));
    }),
  );

  // Balances only move through ledger entries; a manual correction is its own audited entry with a reason.
  app.post(
    "/api/v2/customers/:id/ledger-adjustments",
    command<typeof LedgerAdjustCommand, { id: string }>(
      deps,
      { permission: "customer.ledger_adjust", schema: LedgerAdjustCommand },
      async ({ auth, tx, params }, body) => {
        await getCustomer(tx, params.id, { lock: true });
        await addLedgerEntry(tx, { tenantId: auth.tenantId, userId: auth.userId }, {
          customerId: params.id,
          amountCents: body.amountCents,
          kind: "adjustment",
          reason: body.reason,
        });
        const row = await getCustomer(tx, params.id);
        return {
          status: 201,
          body: toCustomerDto(row),
          audit: {
            action: "customer.ledger_adjust",
            entityType: "customer",
            entityId: params.id,
            data: { amountCents: body.amountCents, reason: body.reason, id: randomUUID() },
          },
        };
      },
    ),
  );
}
