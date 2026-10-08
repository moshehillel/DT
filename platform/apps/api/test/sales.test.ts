import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { balance, call, createHarness, stockedProduct, type Harness } from "./harness.js";

describe("sales and payments", () => {
  let h: Harness;
  let bkn: Harness["diamant"]["stores"][number];

  beforeAll(async () => {
    h = await createHarness();
    bkn = h.diamant.stores.find((s) => s.code === "BKN")!;
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    h.gateway.nextCharge = "approved";
    h.gateway.settleTimeoutsAs = "approved";
    h.gateway.chargeCalls.length = 0;
  });

  const owner = () => ({ token: h.ownerToken, registerId: bkn.registerId });

  it("rings a split cash + card sale and captures the card on the terminal", async () => {
    const variantId = await stockedProduct(h, { sku: "CASE-1", priceCents: 2000, qtyPerStore: 5, stores: [bkn.id] });
    const priced = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      registerId: bkn.registerId,
      lines: [{ kind: "product", variantId, qty: 1 }],
      tenders: [{ method: "cash", amountCents: 1000 }, { method: "card", amountCents: 1178 }],
    });
    expect(priced.statusCode, priced.body).toBe(201);
    // 20.00 at 8.875% = 1.775 -> 1.78 tax.
    expect(priced.data.order.totalCents).toBe(2178);
    expect(priced.data.order.status).toBe("awaiting_payment");
    expect(priced.data.pendingPayments).toHaveLength(1);
    expect(await balance(h, bkn.id, variantId)).toBe(4);

    const paymentId = priced.data.pendingPayments[0].id;
    const confirmed = await call(h.app, "POST", `/api/v2/payments/${paymentId}/confirm`, owner(), {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.data.status).toBe("captured");
    expect(h.gateway.chargeCalls).toHaveLength(1);
    expect(h.gateway.chargeCalls[0]!.amountCents).toBe(1178);

    const order = await call(h.app, "GET", `/api/v2/sales/${priced.data.order.id}`, owner());
    expect(order.data.status).toBe("completed");
    expect(order.data.paidCents).toBe(2178);

    // Confirming again does not charge twice.
    const again = await call(h.app, "POST", `/api/v2/payments/${paymentId}/confirm`, owner(), {});
    expect(again.data.status).toBe("captured");
    expect(h.gateway.chargeCalls).toHaveLength(1);
  });

  it("rejects tenders that do not add up and float amounts", async () => {
    const variantId = await stockedProduct(h, { sku: "CASE-2", priceCents: 1000, qtyPerStore: 2, stores: [bkn.id] });
    const short = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "product", variantId, qty: 1 }],
      tenders: [{ method: "cash", amountCents: 500 }],
    });
    expect(short.statusCode).toBe(422);
    expect(short.data.error.code).toBe("TENDER_INVALID");

    const float = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "product", variantId, qty: 1 }],
      tenders: [{ method: "cash", amountCents: 10.5 }],
    });
    expect(float.statusCode).toBe(400);
    expect(float.data.error.code).toBe("VALIDATION_FAILED");
    expect(await balance(h, bkn.id, variantId)).toBe(2);
  });

  it("replays an Idempotency-Key instead of selling twice, and refuses reuse with a different body", async () => {
    const variantId = await stockedProduct(h, { sku: "CABLE-1", priceCents: 500, qtyPerStore: 10, stores: [bkn.id] });
    const key = `sale-${randomUUID()}`;
    const body = {
      storeId: bkn.id,
      lines: [{ kind: "product", variantId, qty: 2 }],
      tenders: [{ method: "cash", amountCents: 1089 }],
    };
    const first = await call(h.app, "POST", "/api/v2/sales", { ...owner(), key }, body);
    expect(first.statusCode, first.body).toBe(201);
    const second = await call(h.app, "POST", "/api/v2/sales", { ...owner(), key }, body);
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.data.order.id).toBe(first.data.order.id);
    expect(await balance(h, bkn.id, variantId)).toBe(8);

    const reused = await call(h.app, "POST", "/api/v2/sales", { ...owner(), key }, { ...body, lines: [{ kind: "product", variantId, qty: 1 }] });
    expect(reused.statusCode).toBe(422);
    expect(reused.data.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const missing = await call(h.app, "POST", "/api/v2/sales", { ...owner(), key: null }, body);
    expect(missing.data.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await balance(h, bkn.id, variantId)).toBe(8);

    const orders = await h.pool.query(`SELECT count(*)::int AS n FROM orders WHERE id = $1`, [first.data.order.id]);
    expect(orders.rows[0].n).toBe(1);
    const audits = await h.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'sale.create'`, [
      first.data.order.id,
    ]);
    expect(audits.rows[0].n).toBe(1);
  });

  it("collect-later leaves a balance due that a later payment settles", async () => {
    const customer = await call(h.app, "POST", "/api/v2/customers", owner(), { phone: "(347) 555-0101", name: "jane doe" });
    expect(customer.statusCode, customer.body).toBe(200);
    expect(customer.data.phone).toBe("+13475550101");

    const sale = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      customerId: customer.data.id,
      lines: [{ kind: "custom", description: "Screen protector install", qty: 1, unitPriceCents: 3000, taxable: false }],
      tenders: [{ method: "cash", amountCents: 1000 }],
      collectLater: { dueDate: "2026-07-15" },
    });
    expect(sale.statusCode, sale.body).toBe(201);
    expect(sale.data.order.status).toBe("balance_due");
    expect(sale.data.order.balanceDueCents).toBe(2000);
    expect(sale.data.order.balanceDueDate).toBe("2026-07-15");

    const noCustomer = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "custom", description: "x", qty: 1, unitPriceCents: 3000, taxable: false }],
      tenders: [],
      collectLater: { dueDate: "2026-07-15" },
    });
    expect(noCustomer.data.error.code).toBe("TENDER_INVALID");

    const paid = await call(h.app, "POST", `/api/v2/sales/${sale.data.order.id}/payments`, owner(), {
      tenders: [{ method: "cash", amountCents: 2000 }],
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.data.order.status).toBe("completed");
    expect(paid.data.order.balanceDueCents).toBe(0);
  });

  it("a terminal timeout becomes pending_verification and is resolved by lookup, never a second charge", async () => {
    const sale = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "custom", description: "Gift", qty: 1, unitPriceCents: 5000, taxable: false }],
      tenders: [{ method: "card", amountCents: 5000 }],
    });
    expect(sale.statusCode, sale.body).toBe(201);
    const paymentId = sale.data.pendingPayments[0].id;

    h.gateway.nextCharge = "timeout";
    const first = await call(h.app, "POST", `/api/v2/payments/${paymentId}/confirm`, owner(), {});
    expect(first.data.status).toBe("pending_verification");
    const pending = await call(h.app, "GET", `/api/v2/sales/${sale.data.order.id}`, owner());
    expect(pending.data.status).toBe("awaiting_payment");

    // The register retries "confirm": the API only looks the charge up.
    const verified = await call(h.app, "POST", `/api/v2/payments/${paymentId}/verify`, owner(), {});
    expect(verified.data.status).toBe("captured");
    expect(h.gateway.chargeCalls).toHaveLength(1);
    const done = await call(h.app, "GET", `/api/v2/sales/${sale.data.order.id}`, owner());
    expect(done.data.status).toBe("completed");

    // A pending card blocks voiding until it is verified.
    const sale2 = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "custom", description: "Gift", qty: 1, unitPriceCents: 700, taxable: false }],
      tenders: [{ method: "card", amountCents: 700 }],
    });
    h.gateway.settleTimeoutsAs = "unknown";
    await call(h.app, "POST", `/api/v2/payments/${sale2.data.pendingPayments[0].id}/confirm`, owner(), {});
    const voided = await call(h.app, "POST", `/api/v2/sales/${sale2.data.order.id}/void`, owner(), { reason: "customer left" });
    expect(voided.data.error.code).toBe("PAYMENT_STATE_INVALID");
  });

  it("a declined card leaves the sale awaiting payment and voidable", async () => {
    const variantId = await stockedProduct(h, { sku: "CHG-1", priceCents: 1500, qtyPerStore: 1, stores: [bkn.id] });
    const sale = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "product", variantId, qty: 1 }],
      tenders: [{ method: "card", amountCents: 1633 }],
    });
    expect(sale.statusCode, sale.body).toBe(201);
    h.gateway.nextCharge = "declined";
    const declined = await call(h.app, "POST", `/api/v2/payments/${sale.data.pendingPayments[0].id}/confirm`, owner(), {});
    expect(declined.data.status).toBe("declined");
    expect(await balance(h, bkn.id, variantId)).toBe(0);
    const voided = await call(h.app, "POST", `/api/v2/sales/${sale.data.order.id}/void`, owner(), { reason: "card declined" });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.data.status).toBe("voided");
    expect(await balance(h, bkn.id, variantId)).toBe(1);
  });

  it("returns refund proportionally, restock, and cannot be repeated past the sold quantity", async () => {
    const variantId = await stockedProduct(h, { sku: "EAR-1", priceCents: 800, qtyPerStore: 2, stores: [bkn.id] });
    const sale = await call(h.app, "POST", "/api/v2/sales", owner(), {
      storeId: bkn.id,
      lines: [{ kind: "product", variantId, qty: 2 }],
      tenders: [{ method: "cash", amountCents: 1742 }],
    });
    expect(sale.statusCode, sale.body).toBe(201);
    const line = sale.data.order.lines[0];
    const cash = sale.data.order.payments[0];
    const ret = await call(h.app, "POST", `/api/v2/sales/${sale.data.order.id}/returns`, owner(), {
      lines: [{ orderLineId: line.id, qty: 1 }],
      refunds: [{ paymentId: cash.id, amountCents: 871 }],
      reason: "defective",
    });
    expect(ret.statusCode, ret.body).toBe(201);
    expect(ret.data.order.totalCents).toBe(871);
    expect(await balance(h, bkn.id, variantId)).toBe(1);

    const wrong = await call(h.app, "POST", `/api/v2/sales/${sale.data.order.id}/returns`, owner(), {
      lines: [{ orderLineId: line.id, qty: 2 }],
      refunds: [{ paymentId: cash.id, amountCents: 1742 }],
      reason: "again",
    });
    expect(wrong.data.error.code).toBe("RETURN_EXCEEDS_SOLD");
  });
});
