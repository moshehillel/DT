import type { ChargeOutcome } from "@pos/adapters";
import { loadTenant, queueCustomerMessage, settleOrder } from "@pos/api/services";
import { isoDateInZone } from "@pos/domain";
import { withAppRole, withTenant } from "@pos/db";
import type { TenantRef, WorkerDeps } from "./deps.js";

export async function tenants(deps: WorkerDeps): Promise<TenantRef[]> {
  const ids = await withAppRole(deps.pool, async (client) => {
    const result = await client.query<{ id: string }>(`SELECT app_tenant_ids() AS id`);
    return result.rows.map((r) => r.id);
  });
  const refs: TenantRef[] = [];
  for (const id of ids) {
    const slug = await withTenant(deps.pool, { tenantId: id }, async (tx) => {
      const row = await tx.client.query<{ slug: string }>(`SELECT slug FROM tenants LIMIT 1`);
      return row.rows[0]?.slug ?? "";
    });
    refs.push({ id, slug });
  }
  return refs;
}

export interface ReconcileReport {
  checked: number;
  captured: number;
  declined: number;
  stillUnknown: number;
}

/**
 * Card payments whose outcome is unknown (terminal timeout, crash between
 * charge and record) are looked up by their externalRequestId — never
 * charged again. Payments stuck in "processing" for 15+ minutes are included:
 * the register that started them is gone.
 */
export async function reconcilePayments(deps: WorkerDeps, tenant: TenantRef): Promise<ReconcileReport> {
  const ctx = { tenantId: tenant.id, userId: null };
  const report: ReconcileReport = { checked: 0, captured: 0, declined: 0, stillUnknown: 0 };
  const candidates = await withTenant(deps.pool, ctx, async (tx) => {
    const rows = await tx.client.query<{ id: string; order_id: string; external_request_id: string }>(
      `SELECT id, order_id, external_request_id FROM payments
        WHERE method = 'card' AND external_request_id IS NOT NULL
          AND (status = 'pending_verification' OR (status = 'processing' AND created_at < now() - interval '15 minutes'))
        ORDER BY created_at LIMIT 200`,
    );
    return rows.rows;
  });
  if (candidates.length === 0) return report;
  const gateway = await deps.providers.gateway(tenant);

  for (const payment of candidates) {
    report.checked += 1;
    let outcome: ChargeOutcome;
    try {
      outcome = await gateway.lookup(payment.external_request_id);
    } catch (error) {
      outcome = { status: "unknown", message: (error as Error).message };
    }
    await withTenant(deps.pool, ctx, async (tx) => {
      const settings = await loadTenant(tx);
      if (outcome.status === "approved") {
        const updated = await tx.client.query(
          `UPDATE payments SET status = 'captured', gateway_ref = $2, card_summary = $3, last_error = NULL, version = version + 1
            WHERE id = $1 AND status IN ('processing','pending_verification')`,
          [payment.id, outcome.gatewayRef, outcome.cardSummary],
        );
        if (updated.rowCount) {
          report.captured += 1;
          await settleOrder(tx, ctx, payment.order_id, settings);
        }
      } else if (outcome.status === "declined") {
        const updated = await tx.client.query(
          `UPDATE payments SET status = 'declined', last_error = $2, version = version + 1
            WHERE id = $1 AND status IN ('processing','pending_verification')`,
          [payment.id, outcome.message],
        );
        if (updated.rowCount) {
          report.declined += 1;
          await settleOrder(tx, ctx, payment.order_id, settings);
        }
      } else {
        report.stillUnknown += 1;
        await tx.client.query(
          `UPDATE payments SET status = 'pending_verification', last_error = $2, version = version + 1
            WHERE id = $1 AND status IN ('processing','pending_verification')`,
          [payment.id, outcome.message],
        );
      }
      await tx.client.query(
        `INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, data) VALUES ($1,'payment.reconcile','payment',$2,$3)`,
        [tenant.id, payment.id, JSON.stringify({ outcome: outcome.status })],
      );
    });
  }
  return report;
}

/** The day before a rental is due back (store time), queue one reminder per rental. */
export async function rentalReturnReminders(deps: WorkerDeps, tenant: TenantRef): Promise<number> {
  return withTenant(deps.pool, { tenantId: tenant.id }, async (tx) => {
    const settings = await loadTenant(tx);
    const rows = await tx.client.query<{ id: string; return_due_date: string; phone: string; time_zone: string }>(
      `SELECT r.id, r.return_due_date, c.phone, s.time_zone
         FROM rental_contracts r JOIN customers c ON c.id = r.customer_id JOIN stores s ON s.id = r.store_id
        WHERE r.status = 'active' AND r.return_due_date BETWEEN current_date AND current_date + 2`,
    );
    let queued = 0;
    for (const rental of rows.rows) {
      const tomorrow = isoDateInZone(new Date(deps.now().getTime() + 86_400_000), rental.time_zone);
      if (rental.return_due_date !== tomorrow) continue;
      const id = await queueCustomerMessage(tx, tenant.id, {
        dedupeKey: `rental:${rental.id}:return_reminder:${rental.return_due_date}`,
        template: "rental_return_reminder",
        to: rental.phone,
        vars: { company: settings.name, returnDate: rental.return_due_date, companyPhone: settings.company.phone },
      });
      if (id) queued += 1;
    }
    return queued;
  });
}
