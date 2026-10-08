import { randomUUID } from "node:crypto";
import { createPool, seedTenant, type Pool } from "@pos/db";
import { createTestDatabase, type TestDatabase } from "@pos/db/testing";
import { DIAMANT_TENANT_SEED } from "@pos/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { fakeProviders, type WorkerDeps } from "../src/deps.js";
import { reconcilePayments, rentalReturnReminders, tenants } from "../src/jobs.js";
import { backoffMs, processBatch } from "../src/outbox.js";

describe("worker", () => {
  let database: TestDatabase;
  let pool: Pool;
  let seeded: Awaited<ReturnType<typeof seedTenant>>;
  let providers: ReturnType<typeof fakeProviders>;
  let deps: WorkerDeps;
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

  beforeAll(async () => {
    database = await createTestDatabase(inject("pgAdminUrl"));
    pool = createPool(database.url);
    seeded = await seedTenant(pool, DIAMANT_TENANT_SEED, { firebaseUid: "uid-owner", email: "o@x.test", displayName: "Owner" });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });
  beforeEach(async () => {
    providers = fakeProviders();
    deps = { pool, providers, now: () => new Date(), log: silent };
    await pool.query(`UPDATE outbox SET status = 'done' WHERE status IN ('pending','processing')`);
  });

  const enqueueSms = async (opts: { availableAt?: string; maxAttempts?: number } = {}) => {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO outbox (tenant_id, topic, dedupe_key, payload, available_at, max_attempts)
       VALUES ($1, 'notify.sms', $2, $3, coalesce($4::timestamptz, now()), $5) RETURNING id`,
      [
        seeded.tenantId,
        `test:${randomUUID()}`,
        JSON.stringify({ template: "repair_ready", to: "+13475550123", vars: { company: "Diamant Telecom", model: "iPhone 13", ticket: "100001", amountDueLine: "" } }),
        opts.availableAt ?? null,
        opts.maxAttempts ?? 8,
      ],
    );
    return row.rows[0]!.id;
  };
  const outboxRow = async (id: string) =>
    (await pool.query(`SELECT status, attempts, last_error, available_at FROM outbox WHERE id = $1`, [id])).rows[0];

  it("renders the tenant template and sends once", async () => {
    const id = await enqueueSms();
    expect(await processBatch(deps)).toBe(1);
    expect(providers.fakes.sms.sent).toHaveLength(1);
    expect(providers.fakes.sms.sent[0]!.body).toBe("Diamant Telecom: repair ticket 100001 for iPhone 13 is ready for pickup.");
    expect((await outboxRow(id)).status).toBe("done");

    // Even if the message were somehow claimed again, it is not re-sent.
    await pool.query(`UPDATE outbox SET status = 'pending' WHERE id = $1`, [id]);
    await processBatch(deps);
    expect(providers.fakes.sms.sent).toHaveLength(1);
    expect((await outboxRow(id)).status).toBe("done");
  });

  it("does not send scheduled messages early", async () => {
    const id = await enqueueSms({ availableAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await processBatch(deps)).toBe(0);
    expect((await outboxRow(id)).status).toBe("pending");
    expect(providers.fakes.sms.sent).toHaveLength(0);
  });

  it("retries definite failures with backoff and gives up after max attempts", async () => {
    const id = await enqueueSms({ maxAttempts: 2 });
    providers.fakes.sms.failNext = { status: "failed", error: "telebroad 503", retryable: true };
    await processBatch(deps);
    const first = await outboxRow(id);
    expect(first.status).toBe("pending");
    expect(first.attempts).toBe(1);
    expect(new Date(first.available_at).getTime()).toBeGreaterThan(Date.now() + 10_000);

    await pool.query(`UPDATE outbox SET available_at = now() WHERE id = $1`, [id]);
    providers.fakes.sms.failNext = { status: "failed", error: "telebroad 503", retryable: true };
    await processBatch(deps);
    const second = await outboxRow(id);
    expect(second.status).toBe("dead");
    expect(second.last_error).toMatch(/gave up after 2 attempts/);
  });

  it("parks possibly-delivered messages for review instead of sending twice", async () => {
    const unknown = await enqueueSms();
    providers.fakes.sms.failNext = { status: "unknown", error: "timeout after send" };
    await processBatch(deps);
    expect((await outboxRow(unknown)).status).toBe("needs_review");

    // Simulate a worker that crashed after recording "sending": lease expired, row reclaimed.
    const crashed = await enqueueSms();
    await pool.query(
      `INSERT INTO notification_attempts (tenant_id, outbox_id, channel, to_address, body, provider, status) VALUES ($1,$2,'sms','+1','x','sms','sending')`,
      [seeded.tenantId, crashed],
    );
    await pool.query(`UPDATE outbox SET status = 'processing', locked_until = now() - interval '1 minute' WHERE id = $1`, [crashed]);
    await processBatch(deps);
    expect((await outboxRow(crashed)).status).toBe("needs_review");
    expect(providers.fakes.sms.sent).toHaveLength(0);
  });

  it("backoff grows exponentially and is capped", () => {
    expect(backoffMs(1, () => 1)).toBe(30_000);
    expect(backoffMs(3, () => 1)).toBe(120_000);
    expect(backoffMs(30, () => 1)).toBe(6 * 60 * 60_000);
    expect(backoffMs(1, () => 0)).toBe(15_000);
  });

  const cardOrder = async (paymentStatus: string, opts: { gatewayRef?: string; externalRequestId?: string } = {}) => {
    const store = seeded.stores[0]!;
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, store_id, kind, status, receipt_code, subtotal_cents, tax_cents, total_cents, tax_rules_snapshot)
       VALUES ($1,$2,'sale','awaiting_payment',$3,5000,0,5000,'{}') RETURNING id`,
      [seeded.tenantId, store.id, `T${randomUUID().slice(0, 8)}`],
    );
    const payment = await pool.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, order_id, method, amount_cents, status, external_request_id, gateway_ref)
       VALUES ($1,$2,'card',5000,$3,$4,$5) RETURNING id`,
      [seeded.tenantId, order.rows[0]!.id, paymentStatus, opts.externalRequestId ?? randomUUID().replace(/-/g, ""), opts.gatewayRef ?? null],
    );
    return { orderId: order.rows[0]!.id, paymentId: payment.rows[0]!.id };
  };

  it("sends a card refund to the gateway once, and reviews a refund that may already have gone through", async () => {
    const { paymentId } = await cardOrder("captured", { gatewayRef: "ref-1" });
    const refund = await pool.query<{ id: string }>(
      `INSERT INTO refunds (tenant_id, payment_id, amount_cents, status, external_request_id) VALUES ($1,$2,2000,'pending','rf-1') RETURNING id`,
      [seeded.tenantId, paymentId],
    );
    const message = await pool.query<{ id: string }>(
      `INSERT INTO outbox (tenant_id, topic, dedupe_key, payload) VALUES ($1,'payment.refund',$2,$3) RETURNING id`,
      [seeded.tenantId, `refund:${refund.rows[0]!.id}`, JSON.stringify({ refundId: refund.rows[0]!.id })],
    );
    await processBatch(deps);
    expect(providers.fakes.gateway.refundCalls).toEqual([{ externalRequestId: "rf-1", gatewayRef: "ref-1", amountCents: 2000 }]);
    expect((await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refund.rows[0]!.id])).rows[0].status).toBe("succeeded");
    expect((await outboxRow(message.rows[0]!.id)).status).toBe("done");

    const stuck = await pool.query<{ id: string }>(
      `INSERT INTO refunds (tenant_id, payment_id, amount_cents, status, external_request_id) VALUES ($1,$2,1000,'processing','rf-2') RETURNING id`,
      [seeded.tenantId, paymentId],
    );
    await pool.query(`INSERT INTO outbox (tenant_id, topic, dedupe_key, payload) VALUES ($1,'payment.refund',$2,$3)`, [
      seeded.tenantId,
      `refund:${stuck.rows[0]!.id}`,
      JSON.stringify({ refundId: stuck.rows[0]!.id }),
    ]);
    await processBatch(deps);
    expect(providers.fakes.gateway.refundCalls).toHaveLength(1);
    expect((await pool.query(`SELECT status FROM refunds WHERE id = $1`, [stuck.rows[0]!.id])).rows[0].status).toBe("needs_review");
  });

  it("reconciliation looks up unknown card payments and settles the order without charging", async () => {
    const approved = await cardOrder("pending_verification", { externalRequestId: "ext-approved" });
    const unknown = await cardOrder("pending_verification", { externalRequestId: "ext-unknown" });
    providers.fakes.gateway.charges.set("ext-approved", { status: "approved", gatewayRef: "g-1", cardSummary: "VISA ****4242", authCode: "A" });
    const [tenant] = await tenants(deps);
    const report = await reconcilePayments(deps, tenant!);
    expect(report).toEqual({ checked: 2, captured: 1, declined: 0, stillUnknown: 1 });
    expect(providers.fakes.gateway.chargeCalls).toHaveLength(0);
    const order = await pool.query(`SELECT status, paid_cents FROM orders WHERE id = $1`, [approved.orderId]);
    expect(order.rows[0]).toEqual({ status: "completed", paid_cents: 5000 });
    const still = await pool.query(`SELECT status FROM payments WHERE id = $1`, [unknown.paymentId]);
    expect(still.rows[0].status).toBe("pending_verification");
  });

  it("registers a rental SIM with RCUK once and queues the return reminder the day before", async () => {
    const store = seeded.stores[0]!;
    const customer = await pool.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1,'+13475550777','Renter') RETURNING id`,
      [seeded.tenantId],
    );
    const storeZone = (await pool.query(`SELECT time_zone FROM stores WHERE id = $1`, [store.id])).rows[0].time_zone as string;
    const due = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: storeZone });
    const rental = await pool.query<{ id: string }>(
      `INSERT INTO rental_contracts (tenant_id, store_id, customer_id, region, service_type, device_kind, sim_number, start_date, end_date,
                                     return_due_date, total_cents)
       VALUES ($1,$2,$3,'Israel','Data','sim_only','8997201234567890',current_date - 7, $4::date - 1, $4::date, 3500) RETURNING id`,
      [seeded.tenantId, store.id, customer.rows[0]!.id, due],
    );
    await pool.query(`INSERT INTO outbox (tenant_id, topic, dedupe_key, payload) VALUES ($1,'rental.rcuk_add',$2,$3)`, [
      seeded.tenantId,
      `rental:${rental.rows[0]!.id}:rcuk_add`,
      JSON.stringify({ rentalId: rental.rows[0]!.id }),
    ]);
    await processBatch(deps);
    expect(providers.fakes.rcuk.added).toHaveLength(1);
    const row = await pool.query(`SELECT external_rental_id, numbers_status FROM rental_contracts WHERE id = $1`, [rental.rows[0]!.id]);
    expect(row.rows[0]).toEqual({ external_rental_id: "rcuk-1", numbers_status: "requested" });

    const [tenant] = await tenants(deps);
    expect(await rentalReturnReminders(deps, tenant!)).toBe(1);
    expect(await rentalReturnReminders(deps, tenant!)).toBe(0);
  });
});
