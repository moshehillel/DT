import { applyToBalance, StockRuleError, type MovementKind, type StockPolicy } from "@pos/domain";
import type { TxHandle } from "@pos/db";
import { AppError } from "../lib/errors.js";

export interface MovementInput {
  storeId: string;
  variantId: string;
  kind: MovementKind;
  /** Positive units for most kinds; signed for adjust; the counted total for count. */
  qty: number;
  reason?: string | null;
  serializedUnitId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  transferGroupId?: string | null;
  unitCostCents?: number | null;
}

export function mapStockError(error: unknown): never {
  if (error instanceof StockRuleError) {
    if (error.code === "INSUFFICIENT_STOCK") throw new AppError("INSUFFICIENT_STOCK", error.message);
    if (error.code === "INVALID_TRANSITION") throw new AppError("INVALID_TRANSITION", error.message);
    throw new AppError("VALIDATION_FAILED", error.message);
  }
  throw error;
}

/**
 * Append one movement and move the cached balance in the same transaction.
 * The balance row is locked (SELECT ... FOR UPDATE), so two registers selling
 * the same item at the same store serialize, while sales at different stores
 * touch different rows and never block or overwrite each other.
 */
export async function applyMovement(
  tx: TxHandle,
  ctx: { tenantId: string; userId: string },
  input: MovementInput,
  policy: StockPolicy,
): Promise<{ delta: number; after: number }> {
  await tx.client.query(
    `INSERT INTO inventory_balances (tenant_id, store_id, variant_id, qty) VALUES ($1,$2,$3,0)
     ON CONFLICT (store_id, variant_id) DO NOTHING`,
    [ctx.tenantId, input.storeId, input.variantId],
  );
  const current = await tx.client.query<{ qty: number }>(
    `SELECT qty FROM inventory_balances WHERE store_id = $1 AND variant_id = $2 FOR UPDATE`,
    [input.storeId, input.variantId],
  );
  const onHand = current.rows[0]?.qty ?? 0;
  let applied: { delta: number; after: number };
  try {
    applied = applyToBalance(onHand, input.kind, input.qty, policy, input.reason ?? null);
  } catch (error) {
    mapStockError(error);
  }
  if (applied.delta === 0) return applied;
  await tx.client.query(
    `UPDATE inventory_balances SET qty = $3, version = version + 1, updated_at = now()
      WHERE store_id = $1 AND variant_id = $2`,
    [input.storeId, input.variantId, applied.after],
  );
  await tx.client.query(
    `INSERT INTO stock_movements (tenant_id, store_id, variant_id, kind, qty_delta, balance_after, reason, unit_cost_cents,
                                  serialized_unit_id, source_type, source_id, transfer_group_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.tenantId,
      input.storeId,
      input.variantId,
      input.kind,
      applied.delta,
      applied.after,
      input.reason ?? null,
      input.unitCostCents ?? null,
      input.serializedUnitId ?? null,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.transferGroupId ?? null,
      ctx.userId,
    ],
  );
  return applied;
}

/** Move one serialized unit between statuses/stores atomically; fails if someone else already moved it. */
export async function transitionUnit(
  tx: TxHandle,
  input: { imei: string; variantId?: string; fromStatus: string; toStatus: string; fromStoreId?: string | null; toStoreId?: string | null },
): Promise<{ id: string; variantId: string; storeId: string | null }> {
  const result = await tx.client.query<{ id: string; variant_id: string; store_id: string | null }>(
    `UPDATE serialized_units
        SET status = $2, store_id = coalesce($5, store_id), version = version + 1
      WHERE imei = $1 AND status = $3
        AND ($4::uuid IS NULL OR store_id = $4)
        AND ($6::uuid IS NULL OR variant_id = $6)
      RETURNING id, variant_id, store_id`,
    [input.imei, input.toStatus, input.fromStatus, input.fromStoreId ?? null, input.toStoreId ?? null, input.variantId ?? null],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("UNIT_NOT_AVAILABLE", `Handset ${input.imei} is not ${input.fromStatus.replace("_", " ")} here`);
  }
  return { id: row.id, variantId: row.variant_id, storeId: row.store_id };
}
