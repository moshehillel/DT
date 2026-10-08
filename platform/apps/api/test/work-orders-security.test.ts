import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { twilioSignature } from "../src/lib/webhooks.js";
import { call, createHarness, type Harness } from "./harness.js";

describe("work orders", () => {
  let h: Harness;
  let bkn: Harness["diamant"]["stores"][number];

  beforeAll(async () => {
    h = await createHarness();
    bkn = h.diamant.stores.find((s) => s.code === "BKN")!;
  });
  afterAll(async () => {
    await h?.close();
  });

  const intake = (extra: Record<string, unknown> = {}) =>
    call(h.app, "POST", "/api/v2/work-orders", { token: h.ownerToken }, {
      storeId: bkn.id,
      customerPhone: "347-555-0199",
      customerName: "Sam Cohen",
      model: "iPhone 13",
      issue: "Cracked screen",
      fixes: [{ description: "Screen", priceCents: 12000 }],
      devicePasscode: "123456",
      ...extra,
    });

  it("numbers tickets in sequence and queues the received text", async () => {
    const a = await intake();
    const b = await intake();
    expect(a.statusCode, a.body).toBe(201);
    expect(a.data.ticketNumber).toBe(100001);
    expect(b.data.ticketNumber).toBe(100002);
    expect(a.data.totalCents).toBe(12000);
    expect(a.data.hasDevicePasscode).toBe(true);
    const outbox = await h.pool.query(`SELECT topic, payload FROM outbox WHERE dedupe_key = $1`, [`wo:${a.data.id}:received:sms`]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.to).toBe("+13475550199");
    // The passcode is stored encrypted, never in clear text.
    const raw = await h.pool.query(`SELECT device_passcode_enc FROM work_orders WHERE id = $1`, [a.data.id]);
    expect(raw.rows[0].device_passcode_enc).not.toContain("123456");
  });

  it("schedules the ready text, cancels it if the repair leaves ready, and clears secrets on pickup", async () => {
    const wo = await intake();
    const notifyAt = "2026-07-02T14:00:00.000Z";
    const ready = await call(h.app, "POST", `/api/v2/work-orders/${wo.data.id}/status`, { token: h.ownerToken }, {
      status: "ready",
      expectedVersion: wo.data.version,
      notifyAt,
    });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.data.readyNotifyAt).toBe(notifyAt);
    const scheduled = await h.pool.query(`SELECT status, available_at FROM outbox WHERE dedupe_key LIKE $1`, [`wo:${wo.data.id}:ready:%`]);
    expect(scheduled.rows).toHaveLength(1);
    expect(new Date(scheduled.rows[0].available_at).toISOString()).toBe(notifyAt);

    const stale = await call(h.app, "POST", `/api/v2/work-orders/${wo.data.id}/status`, { token: h.ownerToken }, {
      status: "in_repair",
      expectedVersion: wo.data.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.error.code).toBe("VERSION_MISMATCH");

    const back = await call(h.app, "POST", `/api/v2/work-orders/${wo.data.id}/status`, { token: h.ownerToken }, {
      status: "in_repair",
      expectedVersion: ready.data.version,
    });
    expect(back.statusCode, back.body).toBe(200);
    const cancelled = await h.pool.query(`SELECT status FROM outbox WHERE dedupe_key LIKE $1`, [`wo:${wo.data.id}:ready:%`]);
    expect(cancelled.rows[0].status).toBe("cancelled");

    const printed = await call(h.app, "GET", `/api/v2/work-orders/${wo.data.id}/print`, { token: h.ownerToken });
    expect(printed.data.devicePasscode).toBe("123456");
    const reveal = await h.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'work_order.reveal_passcode'`, [
      wo.data.id,
    ]);
    expect(reveal.rows[0].n).toBe(1);

    const picked = await call(h.app, "POST", `/api/v2/work-orders/${wo.data.id}/status`, { token: h.ownerToken }, {
      status: "picked_up",
      expectedVersion: back.data.version,
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.data.hasDevicePasscode).toBe(false);
    const after = await call(h.app, "GET", `/api/v2/work-orders/${wo.data.id}/print`, { token: h.ownerToken });
    expect(after.data.devicePasscode).toBeNull();
  });

  it("selling a repair settles it and records the payment on the ticket", async () => {
    const wo = await intake({ fixes: [{ description: "Battery", priceCents: 6000 }] });
    const sale = await call(h.app, "POST", "/api/v2/sales", { token: h.ownerToken }, {
      storeId: bkn.id,
      lines: [{ kind: "work_order", workOrderId: wo.data.id }],
      tenders: [{ method: "cash", amountCents: 6533 }],
    });
    expect(sale.statusCode, sale.body).toBe(201);
    expect(sale.data.order.status).toBe("completed");
    const after = await call(h.app, "GET", `/api/v2/work-orders/${wo.data.id}`, { token: h.ownerToken });
    expect(after.data.paidCents).toBe(6000);
    const again = await call(h.app, "POST", "/api/v2/sales", { token: h.ownerToken }, {
      storeId: bkn.id,
      lines: [{ kind: "work_order", workOrderId: wo.data.id }],
      tenders: [{ method: "cash", amountCents: 6533 }],
    });
    expect(again.data.error.code).toBe("CONFLICT");
  });
});

describe("security", () => {
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

  it("requires a valid sign-in", async () => {
    const none = await h.app.inject({ method: "GET", url: "/api/v2/me" });
    expect(none.statusCode).toBe(401);
    const forged = await call(h.app, "GET", "/api/v2/me", { token: "not-a-jwt" });
    expect(forged.statusCode).toBe(401);
    const me = await call(h.app, "GET", "/api/v2/me", { token: h.ownerToken });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.data.role).toBe("owner");
    expect(me.data.stores.map((s: { code: string }) => s.code).sort()).toEqual(["BKN", "CAT", "UPS"]);
  });

  it("isolates tenants through the API", async () => {
    const wo = await call(h.app, "POST", "/api/v2/work-orders", { token: h.ownerToken }, {
      storeId: bkn.id,
      model: "Galaxy S22",
      issue: "Charging port",
    });
    expect(wo.statusCode, wo.body).toBe(201);
    const peek = await call(h.app, "GET", `/api/v2/work-orders/${wo.data.id}`, { token: h.otherToken });
    expect(peek.statusCode).toBe(404);
    const garbage = await call(h.app, "GET", `/api/v2/work-orders/not-a-uuid`, { token: h.ownerToken });
    expect(garbage.statusCode).toBe(400);
    const list = await call(h.app, "GET", "/api/v2/work-orders?status=all", { token: h.otherToken });
    expect(list.data.items).toEqual([]);
    // Other tenant's owner cannot act in Diamant's store either.
    const sell = await call(h.app, "POST", "/api/v2/sales", { token: h.otherToken }, {
      storeId: bkn.id,
      lines: [{ kind: "custom", description: "x", qty: 1, unitPriceCents: 100, taxable: false }],
      tenders: [{ method: "cash", amountCents: 100 }],
    });
    expect(sell.statusCode).toBe(404);
    const spoof = await h.app.inject({
      method: "GET",
      url: "/api/v2/me",
      headers: { authorization: `Bearer ${h.otherToken}`, "x-tenant-id": h.diamant.tenantId },
    });
    expect(spoof.statusCode).toBe(403);
  });

  it("enforces roles and store scope", async () => {
    const cashier = await h.addMember("cashier", bkn.id);
    const product = await call(h.app, "POST", "/api/v2/products", { token: cashier.token }, {
      name: "Nope",
      variants: [{ sku: "NOPE", priceCents: 100 }],
    });
    expect(product.statusCode).toBe(403);
    const otherStore = await call(h.app, "POST", "/api/v2/sales", { token: cashier.token }, {
      storeId: ups.id,
      lines: [{ kind: "custom", description: "x", qty: 1, unitPriceCents: 100, taxable: false }],
      tenders: [{ method: "cash", amountCents: 100 }],
    });
    expect(otherStore.statusCode).toBe(403);
    const ownStore = await call(h.app, "POST", "/api/v2/sales", { token: cashier.token }, {
      storeId: bkn.id,
      lines: [{ kind: "custom", description: "x", qty: 1, unitPriceCents: 100, taxable: false }],
      tenders: [{ method: "cash", amountCents: 100 }],
    });
    expect(ownStore.statusCode, ownStore.body).toBe(201);
    const driver = await h.addMember("driver");
    const driverSale = await call(h.app, "GET", "/api/v2/sales", { token: driver.token });
    expect(driverSale.statusCode).toBe(403);
  });

  it("PIN switch puts the cashier's permissions on a manager's device", async () => {
    const cashier = await h.addMember("cashier", bkn.id);
    const set = await call(h.app, "POST", `/api/v2/staff/${cashier.membershipId}/pin`, { token: h.ownerToken }, { pin: "4821" });
    expect(set.statusCode, set.body).toBe(204);
    const wrong = await call(h.app, "POST", "/api/v2/auth/pin-switch", { token: h.ownerToken }, { membershipId: cashier.membershipId, pin: "0000" });
    expect(wrong.statusCode).toBe(401);
    const ok = await call(h.app, "POST", "/api/v2/auth/pin-switch", { token: h.ownerToken }, { membershipId: cashier.membershipId, pin: "4821" });
    expect(ok.statusCode, ok.body).toBe(200);
    const asCashier = await call(h.app, "POST", "/api/v2/products", { token: h.ownerToken, operatorToken: ok.data.operatorToken }, {
      name: "Nope",
      variants: [{ sku: "NOPE2", priceCents: 100 }],
    });
    expect(asCashier.statusCode).toBe(403);
    // An operator token is bound to the device that unlocked it.
    const stolen = await call(h.app, "GET", "/api/v2/me", { token: h.otherToken, operatorToken: ok.data.operatorToken });
    expect(stolen.statusCode).toBe(401);
    const audit = await h.pool.query(`SELECT action FROM audit_log WHERE operator_membership_id = $1 ORDER BY id`, [cashier.membershipId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["auth.pin_switch_failed", "auth.pin_switch"]);
  });

  it("verifies webhook signatures and stores each event once", async () => {
    const body = JSON.stringify({ id: 9001, total_price: "10.00" });
    const signature = createHmac("sha256", "shopify-test-secret").update(body).digest("base64");
    const send = (sig: string) =>
      h.app.inject({
        method: "POST",
        url: "/api/v2/webhooks/diamant-telecom/shopify/orders",
        headers: { "content-type": "application/json", "x-shopify-hmac-sha256": sig, "x-shopify-webhook-id": "wh-9001" },
        payload: body,
      });
    expect((await send("bad")).statusCode).toBe(401);
    expect((await send(signature)).statusCode).toBe(202);
    const dup = await send(signature);
    expect(dup.statusCode).toBe(200);
    expect(JSON.parse(dup.body).duplicate).toBe(true);
    const queued = await h.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE dedupe_key = 'shopify:wh-9001'`);
    expect(queued.rows[0].n).toBe(1);
  });

  it("answers the IVR with the repair status for a signed Twilio request", async () => {
    const wo = await call(h.app, "POST", "/api/v2/work-orders", { token: h.ownerToken }, {
      storeId: bkn.id,
      model: "Pixel 7",
      issue: "Battery",
    });
    const url = "/api/v2/webhooks/diamant-telecom/twilio/voice";
    const params = { CallSid: "CA123", Digits: String(wo.data.ticketNumber), From: "+13475550000" };
    const response = await h.app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature("twilio-test-token", `https://api.test${url}`, params),
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("Pixel 7 repair status is Received");
    const unsigned = await h.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(params).toString(),
    });
    expect(unsigned.statusCode).toBe(401);
  });
});
