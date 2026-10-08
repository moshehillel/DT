import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balance, call, createHarness, stockedProduct, type Harness } from "./harness.js";

describe("concurrency", () => {
  let h: Harness;
  let bkn: Harness["diamant"]["stores"][number];
  let ups: Harness["diamant"]["stores"][number];

  beforeAll(async () => {
    h = await createHarness();
    bkn = h.diamant.stores.find((s) => s.code === "BKN")!;
    ups = h.diamant.stores.find((s) => s.code === "UPS")!;
  });
  afterAll(async () => {
    await h?.close();
  });

  const sell = (storeId: string, registerId: string, variantId: string, cashCents: number) =>
    call(h.app, "POST", "/api/v2/sales", { token: h.ownerToken, registerId }, {
      storeId,
      registerId,
      lines: [{ kind: "product", variantId, qty: 1 }],
      tenders: [{ method: "cash", amountCents: cashCents }],
    });

  it("two stores selling the same item at once both keep exact counts", async () => {
    const variantId = await stockedProduct(h, { sku: "HOT-1", priceCents: 1000, qtyPerStore: 10, stores: [bkn.id, ups.id] });
    // BKN 8.875% -> 1089, UPS 8.125% -> 1081
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => sell(bkn.id, bkn.registerId, variantId, 1089)),
      ...Array.from({ length: 6 }, () => sell(ups.id, ups.registerId, variantId, 1081)),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual(Array(12).fill(201));
    expect(await balance(h, bkn.id, variantId)).toBe(4);
    expect(await balance(h, ups.id, variantId)).toBe(4);
    const movements = await h.pool.query(
      `SELECT store_id, count(*)::int AS n, sum(qty_delta)::int AS total FROM stock_movements
        WHERE variant_id = $1 AND kind = 'sale' GROUP BY store_id ORDER BY store_id`,
      [variantId],
    );
    expect(movements.rows.map((r) => r.total)).toEqual([-6, -6]);
  });

  it("concurrent sales never oversell the last units", async () => {
    const variantId = await stockedProduct(h, { sku: "LAST-1", priceCents: 1000, qtyPerStore: 3, stores: [bkn.id] });
    const results = await Promise.all(Array.from({ length: 8 }, () => sell(bkn.id, bkn.registerId, variantId, 1089)));
    const ok = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode !== 201);
    expect(ok).toHaveLength(3);
    expect(refused.map((r) => r.data.error.code)).toEqual(Array(5).fill("INSUFFICIENT_STOCK"));
    expect(await balance(h, bkn.id, variantId)).toBe(0);
  });

  it("concurrent refunds cannot exceed what was paid on a payment", async () => {
    // 2 x 8.00 = 16.00 + 1.42 tax = 17.42, paid 10.00 cash + 7.42 account-free check.
    const variantId = await stockedProduct(h, { sku: "REF-1", priceCents: 800, qtyPerStore: 2, stores: [bkn.id] });
    const sale = await call(h.app, "POST", "/api/v2/sales", { token: h.ownerToken, registerId: bkn.registerId }, {
      storeId: bkn.id,
      lines: [{ kind: "product", variantId, qty: 2 }],
      tenders: [{ method: "cash", amountCents: 1000 }, { method: "check", amountCents: 742 }],
    });
    expect(sale.statusCode, sale.body).toBe(201);
    const line = sale.data.order.lines[0];
    const cash = sale.data.order.payments.find((p: { method: string }) => p.method === "cash");
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        call(h.app, "POST", `/api/v2/sales/${sale.data.order.id}/returns`, { token: h.ownerToken, registerId: bkn.registerId }, {
          lines: [{ orderLineId: line.id, qty: 1 }],
          refunds: [{ paymentId: cash.id, amountCents: 871 }],
          reason: "both registers refunding",
        }),
      ),
    );
    const codes = results.map((r) => (r.statusCode === 201 ? "ok" : r.data.error.code)).sort();
    expect(codes).toEqual(["REFUND_EXCEEDS_PAYMENT", "ok"]);
    const payment = await h.pool.query(`SELECT refunded_cents FROM payments WHERE id = $1`, [cash.id]);
    expect(payment.rows[0].refunded_cents).toBe(871);
    // The failed attempt rolled back completely: only one unit went back on the shelf.
    expect(await balance(h, bkn.id, variantId)).toBe(1);
  });

  it("concurrent returns of the same line cannot exceed the sold quantity", async () => {
    const variantId = await stockedProduct(h, { sku: "RET-1", priceCents: 1000, qtyPerStore: 1, stores: [bkn.id] });
    const sale = await sell(bkn.id, bkn.registerId, variantId, 1089);
    expect(sale.statusCode, sale.body).toBe(201);
    const line = sale.data.order.lines[0];
    const cash = sale.data.order.payments[0];
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(h.app, "POST", `/api/v2/sales/${sale.data.order.id}/returns`, { token: h.ownerToken }, {
          lines: [{ orderLineId: line.id, qty: 1 }],
          refunds: [{ paymentId: cash.id, amountCents: 1089 }],
          reason: "returned",
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await balance(h, bkn.id, variantId)).toBe(1);
  });

  it("the same idempotency key sent concurrently applies once", async () => {
    const variantId = await stockedProduct(h, { sku: "DUP-1", priceCents: 1000, qtyPerStore: 5, stores: [bkn.id] });
    const key = "double-tap-0001";
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(h.app, "POST", "/api/v2/sales", { token: h.ownerToken, key }, {
          storeId: bkn.id,
          lines: [{ kind: "product", variantId, qty: 1 }],
          tenders: [{ method: "cash", amountCents: 1089 }],
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(4).fill(201));
    expect(new Set(results.map((r) => r.data.order.id)).size).toBe(1);
    expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(3);
    expect(await balance(h, bkn.id, variantId)).toBe(4);
  });
});
