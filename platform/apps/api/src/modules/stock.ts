import { randomUUID } from "node:crypto";
import {
  CreateProductCommand,
  StockAdjustCommand,
  StockCountCommand,
  StockReceiveCommand,
  StockTransferCommand,
} from "@pos/contracts";
import { normalizeImei, planTransfer, StockRuleError } from "@pos/domain";
import { isUniqueViolation, type TxHandle } from "@pos/db";
import type { FastifyInstance } from "fastify";
import { effective, requireStoreAccess } from "../lib/auth.js";
import { command, query } from "../lib/command.js";
import type { Deps } from "../lib/deps.js";
import { AppError, notFound } from "../lib/errors.js";
import { decodeCursor, pageLimit, toPage } from "../lib/pagination.js";
import { applyMovement, mapStockError, transitionUnit } from "../services/stock.js";
import { loadStore, loadTenant } from "../services/tenant.js";

async function loadVariant(tx: TxHandle, variantId: string) {
  const result = await tx.client.query<{ id: string; serialized: boolean; name: string }>(
    `SELECT id, serialized, name FROM product_variants WHERE id = $1`,
    [variantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Product");
  return row;
}

function cleanImeis(list: string[] | undefined): string[] {
  try {
    const imeis = (list ?? []).map(normalizeImei);
    if (new Set(imeis).size !== imeis.length) throw new AppError("VALIDATION_FAILED", "The same IMEI is listed twice");
    return imeis;
  } catch (error) {
    if (error instanceof StockRuleError) throw new AppError("VALIDATION_FAILED", error.message);
    throw error;
  }
}

const CATALOG_SELECT = `
  SELECT v.id AS variant_id, v.product_id, v.sku, v.name, p.category, v.barcode, v.price_cents, v.serialized, v.created_at, v.id
    FROM product_variants v JOIN products p ON p.id = v.product_id`;

function toCatalogItem(r: {
  variant_id: string;
  product_id: string;
  sku: string;
  name: string;
  category: string;
  barcode: string | null;
  price_cents: number;
  serialized: boolean;
}) {
  return {
    variantId: r.variant_id,
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    category: r.category,
    barcode: r.barcode,
    priceCents: r.price_cents,
    serialized: r.serialized,
  };
}

export function registerStock(app: FastifyInstance, deps: Deps) {
  app.post(
    "/api/v2/products",
    command(deps, { permission: "catalog.write", schema: CreateProductCommand }, async ({ auth, tx }, body) => {
      const productId = randomUUID();
      await tx.client.query(
        `INSERT INTO products (id, tenant_id, name, category, tax_category, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [productId, auth.tenantId, body.name, body.category, body.taxCategory ?? null, auth.userId],
      );
      const variants = [];
      for (const v of body.variants) {
        try {
          await tx.client.query(`SAVEPOINT variant`);
          const row = await tx.client.query(
            `INSERT INTO product_variants (tenant_id, product_id, sku, name, barcode, price_cents, serialized, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [auth.tenantId, productId, v.sku, v.name ?? body.name, v.barcode ?? null, v.priceCents, v.serialized, auth.userId],
          );
          await tx.client.query(`RELEASE SAVEPOINT variant`);
          variants.push({ variantId: row.rows[0].id, sku: v.sku });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError("CONFLICT", `SKU ${v.sku} or its barcode is already used by another item`);
          }
          throw error;
        }
      }
      return {
        status: 201,
        body: { productId, variants },
        audit: { action: "catalog.create", entityType: "product", entityId: productId, data: { name: body.name, variants } },
      };
    }),
  );

  app.get(
    "/api/v2/products",
    query<Record<string, string>, { q?: string; cursor?: string; limit?: string }>(deps, "stock.read", async ({ tx, query: q }) => {
      const params: unknown[] = [];
      const where = ["v.active", "p.active"];
      if (q.q) {
        params.push(`%${q.q}%`);
        where.push(`(v.name ILIKE $${params.length} OR v.sku ILIKE $${params.length} OR v.barcode = $${params.length + 1})`);
        params.push(q.q);
      }
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where.push(`(v.created_at, v.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const limit = pageLimit(q.limit);
      params.push(limit + 1);
      const rows = await tx.client.query(
        `${CATALOG_SELECT} WHERE ${where.join(" AND ")} ORDER BY v.created_at DESC, v.id DESC LIMIT $${params.length}`,
        params,
      );
      return toPage(rows.rows, limit, toCatalogItem);
    }),
  );

  /** Scanner lookup: barcode, SKU or IMEI. */
  app.get(
    "/api/v2/products/lookup",
    query<Record<string, string>, { code?: string; storeId?: string }>(deps, "stock.read", async ({ tx, query: q }) => {
      const code = String(q.code ?? "").trim();
      if (!code) throw new AppError("VALIDATION_FAILED", "code is required");
      const byCode = await tx.client.query(`${CATALOG_SELECT} WHERE v.active AND (upper(v.barcode) = upper($1) OR upper(v.sku) = upper($1))`, [
        code,
      ]);
      if (byCode.rows[0]) return { item: toCatalogItem(byCode.rows[0]), imei: null };
      const digits = code.replace(/\D/g, "");
      if (digits.length >= 14) {
        const unit = await tx.client.query<{ variant_id: string; status: string; store_id: string | null }>(
          `SELECT variant_id, status, store_id FROM serialized_units WHERE imei = $1`,
          [digits],
        );
        const u = unit.rows[0];
        if (u) {
          const item = await tx.client.query(`${CATALOG_SELECT} WHERE v.id = $1`, [u.variant_id]);
          return { item: toCatalogItem(item.rows[0]), imei: { imei: digits, status: u.status, storeId: u.store_id } };
        }
      }
      throw notFound("Item");
    }),
  );

  app.get(
    "/api/v2/stock/balances",
    query<Record<string, string>, { storeId?: string; q?: string; cursor?: string; limit?: string }>(
      deps,
      "stock.read",
      async ({ auth, tx, query: q }) => {
        const storeId = effective(auth).storeId ?? q.storeId;
        if (!storeId) throw new AppError("VALIDATION_FAILED", "storeId is required");
        const params: unknown[] = [storeId];
        const where = ["v.active"];
        if (q.q) {
          params.push(`%${q.q}%`);
          where.push(`(v.name ILIKE $${params.length} OR v.sku ILIKE $${params.length})`);
        }
        const cursor = decodeCursor(q.cursor);
        if (cursor) {
          params.push(cursor.createdAt, cursor.id);
          where.push(`(v.created_at, v.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        const limit = pageLimit(q.limit);
        params.push(limit + 1);
        const rows = await tx.client.query<{
          id: string;
          created_at: Date;
          sku: string;
          name: string;
          serialized: boolean;
          qty: number | null;
          version: number | null;
        }>(
          `SELECT v.id, v.created_at, v.sku, v.name, v.serialized, b.qty, b.version
             FROM product_variants v LEFT JOIN inventory_balances b ON b.variant_id = v.id AND b.store_id = $1
            WHERE ${where.join(" AND ")} ORDER BY v.created_at DESC, v.id DESC LIMIT $${params.length}`,
          params,
        );
        return toPage(rows.rows, limit, (r) => ({
          variantId: r.id,
          storeId,
          sku: r.sku,
          name: r.name,
          serialized: r.serialized,
          qty: r.qty ?? 0,
          version: r.version ?? 0,
        }));
      },
    ),
  );

  app.get(
    "/api/v2/stock/movements",
    query<Record<string, string>, { storeId?: string; variantId?: string; cursor?: string; limit?: string }>(
      deps,
      "stock.read",
      async ({ auth, tx, query: q }) => {
        const params: unknown[] = [];
        const where: string[] = [];
        const storeId = effective(auth).storeId ?? q.storeId;
        if (storeId) {
          params.push(storeId);
          where.push(`store_id = $${params.length}`);
        }
        if (q.variantId) {
          params.push(q.variantId);
          where.push(`variant_id = $${params.length}`);
        }
        const cursor = decodeCursor(q.cursor);
        if (cursor) {
          params.push(cursor.createdAt, cursor.id);
          where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        const limit = pageLimit(q.limit);
        params.push(limit + 1);
        const rows = await tx.client.query(
          `SELECT id, store_id, variant_id, kind, qty_delta, balance_after, reason, source_type, source_id, created_at
             FROM stock_movements ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
          params,
        );
        return toPage(rows.rows, limit, (r) => ({
          id: r.id,
          storeId: r.store_id,
          variantId: r.variant_id,
          kind: r.kind,
          qtyDelta: r.qty_delta,
          balanceAfter: r.balance_after,
          reason: r.reason,
          sourceType: r.source_type,
          sourceId: r.source_id,
          createdAt: r.created_at.toISOString(),
        }));
      },
    ),
  );

  app.post(
    "/api/v2/stock/receive",
    command(deps, { permission: "stock.receive", schema: StockReceiveCommand }, async ({ auth, tx, requestId }, body) => {
      requireStoreAccess(auth, body.storeId);
      const [tenant] = await Promise.all([loadTenant(tx), loadStore(tx, body.storeId)]);
      const ctx = { tenantId: auth.tenantId, userId: auth.userId };
      const results = [];
      for (const line of body.lines) {
        const variant = await loadVariant(tx, line.variantId);
        if (variant.serialized) {
          const imeis = cleanImeis(line.imeis);
          if (!imeis.length) throw new AppError("VALIDATION_FAILED", `Scan the IMEIs for ${variant.name}`);
          for (const imei of imeis) {
            await tx.client.query(`SAVEPOINT unit`);
            let unitId: string;
            try {
              const unit = await tx.client.query<{ id: string }>(
                `INSERT INTO serialized_units (tenant_id, variant_id, store_id, imei, status, created_by)
                 VALUES ($1,$2,$3,$4,'in_stock',$5) RETURNING id`,
                [auth.tenantId, variant.id, body.storeId, imei, auth.userId],
              );
              unitId = unit.rows[0]!.id;
              await tx.client.query(`RELEASE SAVEPOINT unit`);
            } catch (error) {
              if (isUniqueViolation(error)) throw new AppError("CONFLICT", `IMEI ${imei} is already in the system`);
              throw error;
            }
            await applyMovement(
              tx,
              ctx,
              {
                storeId: body.storeId,
                variantId: variant.id,
                kind: "receive",
                qty: 1,
                serializedUnitId: unitId,
                unitCostCents: line.unitCostCents ?? null,
                sourceType: "receive",
                sourceId: body.reference ?? requestId,
              },
              { allowNegative: tenant.allowNegativeStock },
            );
          }
          results.push({ variantId: variant.id, received: imeis.length });
        } else {
          if (!line.qty) throw new AppError("VALIDATION_FAILED", `Enter a quantity for ${variant.name}`);
          if (line.imeis?.length) throw new AppError("VALIDATION_FAILED", `${variant.name} is not tracked by IMEI`);
          await applyMovement(
            tx,
            ctx,
            {
              storeId: body.storeId,
              variantId: variant.id,
              kind: "receive",
              qty: line.qty,
              unitCostCents: line.unitCostCents ?? null,
              sourceType: "receive",
              sourceId: body.reference ?? requestId,
            },
            { allowNegative: tenant.allowNegativeStock },
          );
          results.push({ variantId: variant.id, received: line.qty });
        }
      }
      return {
        status: 201,
        body: { received: results },
        audit: { action: "stock.receive", entityType: "store", entityId: body.storeId, storeId: body.storeId, data: { results, reference: body.reference } },
      };
    }),
  );

  app.post(
    "/api/v2/stock/transfers",
    command(deps, { permission: "stock.transfer", schema: StockTransferCommand }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.fromStoreId);
      const [tenant] = await Promise.all([loadTenant(tx), loadStore(tx, body.fromStoreId), loadStore(tx, body.toStoreId)]);
      const ctx = { tenantId: auth.tenantId, userId: auth.userId };
      const groupId = randomUUID();
      for (const line of body.lines) {
        const variant = await loadVariant(tx, line.variantId);
        const units = variant.serialized ? cleanImeis(line.imeis) : [];
        const qty = variant.serialized ? units.length : (line.qty ?? 0);
        try {
          planTransfer(body.fromStoreId, body.toStoreId, qty);
        } catch (error) {
          mapStockError(error);
        }
        for (const imei of units) {
          await transitionUnit(tx, {
            imei,
            variantId: variant.id,
            fromStatus: "in_stock",
            toStatus: "in_stock",
            fromStoreId: body.fromStoreId,
            toStoreId: body.toStoreId,
          });
        }
        const common = { variantId: variant.id, qty, transferGroupId: groupId, sourceType: "transfer", sourceId: groupId };
        await applyMovement(tx, ctx, { ...common, storeId: body.fromStoreId, kind: "transfer_out" }, { allowNegative: tenant.allowNegativeStock });
        await applyMovement(tx, ctx, { ...common, storeId: body.toStoreId, kind: "transfer_in" }, { allowNegative: tenant.allowNegativeStock });
      }
      return {
        status: 201,
        body: { transferId: groupId },
        audit: {
          action: "stock.transfer",
          entityType: "transfer",
          entityId: groupId,
          storeId: body.fromStoreId,
          data: { to: body.toStoreId, lines: body.lines, note: body.note },
        },
      };
    }),
  );

  app.post(
    "/api/v2/stock/counts",
    command(deps, { permission: "stock.count", schema: StockCountCommand }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.storeId);
      const [tenant] = await Promise.all([loadTenant(tx), loadStore(tx, body.storeId)]);
      const ctx = { tenantId: auth.tenantId, userId: auth.userId };
      const countId = randomUUID();
      const changes = [];
      for (const count of body.counts) {
        const variant = await loadVariant(tx, count.variantId);
        if (variant.serialized) {
          throw new AppError("VALIDATION_FAILED", `${variant.name} is counted by scanning IMEIs, not by number`);
        }
        const applied = await applyMovement(
          tx,
          ctx,
          { storeId: body.storeId, variantId: variant.id, kind: "count", qty: count.countedQty, reason: body.note ?? "cycle count", sourceType: "count", sourceId: countId },
          { allowNegative: tenant.allowNegativeStock },
        );
        changes.push({ variantId: variant.id, delta: applied.delta, qty: applied.after });
      }
      return {
        status: 201,
        body: { countId, changes },
        audit: { action: "stock.count", entityType: "count", entityId: countId, storeId: body.storeId, data: { changes } },
      };
    }),
  );

  app.post(
    "/api/v2/stock/adjustments",
    command(deps, { permission: "stock.adjust", schema: StockAdjustCommand }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.storeId);
      const [tenant] = await Promise.all([loadTenant(tx), loadStore(tx, body.storeId)]);
      const variant = await loadVariant(tx, body.variantId);
      if (variant.serialized) throw new AppError("VALIDATION_FAILED", "Adjust handsets one IMEI at a time (RMA / write-off)");
      const id = randomUUID();
      const applied = await applyMovement(
        tx,
        { tenantId: auth.tenantId, userId: auth.userId },
        { storeId: body.storeId, variantId: variant.id, kind: "adjust", qty: body.qty, reason: body.reason, sourceType: "adjustment", sourceId: id },
        { allowNegative: tenant.allowNegativeStock },
      );
      return {
        status: 201,
        body: { adjustmentId: id, qty: applied.after },
        audit: { action: "stock.adjust", entityType: "adjustment", entityId: id, storeId: body.storeId, data: { qty: body.qty, reason: body.reason, note: body.note } },
      };
    }),
  );
}
