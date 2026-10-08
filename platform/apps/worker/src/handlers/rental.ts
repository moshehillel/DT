import { withTenant } from "@pos/db";
import type { TenantRef, WorkerDeps } from "../deps.js";
import type { ClaimedMessage, Outcome } from "../outbox.js";

/** Register the SIM with RCUK. numbers_status 'requesting' is committed first so a crash mid-call is reviewed, not repeated. */
export async function handleRcukAdd(deps: WorkerDeps, tenant: TenantRef, message: ClaimedMessage): Promise<Outcome> {
  const { rentalId } = message.payload as { rentalId: string };
  const ctx = { tenantId: tenant.id };
  const claim = await withTenant(deps.pool, ctx, async (tx) => {
    const row = await tx.client.query<{
      sim_number: string;
      start_date: string;
      end_date: string;
      region: string;
      service_type: string;
      add_sms: boolean;
      external_rental_id: string | null;
      numbers_status: string;
    }>(
      `SELECT sim_number, start_date, end_date, region, service_type, add_sms, external_rental_id, numbers_status
         FROM rental_contracts WHERE id = $1 FOR UPDATE`,
      [rentalId],
    );
    const rental = row.rows[0];
    if (!rental) return { outcome: { kind: "dead", error: "rental not found" } as Outcome };
    if (rental.external_rental_id) return { outcome: { kind: "done", note: "already registered" } as Outcome };
    if (rental.numbers_status === "requesting") {
      await tx.client.query(`UPDATE rental_contracts SET numbers_status = 'needs_review', version = version + 1 WHERE id = $1`, [rentalId]);
      return { outcome: { kind: "review", error: "a previous RCUK request may have created the rental" } as Outcome };
    }
    await tx.client.query(`UPDATE rental_contracts SET numbers_status = 'requesting', version = version + 1 WHERE id = $1`, [rentalId]);
    return { rental };
  });
  if (claim.outcome) return claim.outcome;
  const rental = claim.rental!;

  let result: { ok: boolean; rentalId: string | null; message: string } | null = null;
  let thrown: string | null = null;
  try {
    const rcuk = await deps.providers.rcuk(tenant);
    result = await rcuk.addRental({
      simNumber: rental.sim_number,
      startDate: rental.start_date,
      endDate: rental.end_date,
      region: rental.region,
      serviceType: rental.service_type,
      addSms: rental.add_sms,
      reference: rentalId,
    });
  } catch (error) {
    thrown = (error as Error).message;
  }

  return withTenant(deps.pool, ctx, async (tx): Promise<Outcome> => {
    if (result?.ok && result.rentalId) {
      await tx.client.query(
        `UPDATE rental_contracts SET external_rental_id = $2, numbers_status = 'requested', version = version + 1 WHERE id = $1`,
        [rentalId, result.rentalId],
      );
      return { kind: "done" };
    }
    if (result && !result.ok) {
      // RCUK answered with a definite failure: safe to try again.
      await tx.client.query(`UPDATE rental_contracts SET numbers_status = 'pending', version = version + 1 WHERE id = $1`, [rentalId]);
      return { kind: "retry", error: `RCUK refused: ${result.message}` };
    }
    await tx.client.query(`UPDATE rental_contracts SET numbers_status = 'needs_review', version = version + 1 WHERE id = $1`, [rentalId]);
    return { kind: "review", error: `RCUK outcome unknown: ${thrown ?? result?.message ?? "no rental id returned"}` };
  });
}

/**
 * Deposit refunds depend on how the deposit was taken (card hold, cash,
 * Zelle). Not automated yet: parked for a manager with the details.
 */
export async function handleDepositRefund(_deps: WorkerDeps, _tenant: TenantRef, message: ClaimedMessage): Promise<Outcome> {
  return { kind: "review", error: `deposit refund needs a manager (deposit ${String(message.payload.depositId)})` };
}
