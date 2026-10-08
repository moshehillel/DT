import { randomBytes, randomUUID } from "node:crypto";
import { FakePaymentGateway, StaticSecretProvider } from "@pos/adapters";
import { createPool, seedTenant, type Pool } from "@pos/db";
import { createTestDatabase, type TestDatabase } from "@pos/db/testing";
import { DIAMANT_TENANT_SEED, type Role, type TenantSeed } from "@pos/domain";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { inject } from "vitest";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier, OperatorTokens } from "../src/lib/auth.js";
import { EnvKeyProvider, FieldCipher } from "../src/lib/crypto.js";

export const DEV_SECRET = "test-dev-secret-0123456789abcdefghijklmnop";

export const OTHER_SEED: TenantSeed = {
  ...DIAMANT_TENANT_SEED,
  slug: "other-shop",
  name: "Other Shop",
  stores: [{ ...DIAMANT_TENANT_SEED.stores[0]!, code: "OTH", name: "Other main" }],
};

export interface Harness {
  app: FastifyInstance;
  pool: Pool;
  gateway: FakePaymentGateway;
  secrets: StaticSecretProvider;
  clock: { now: Date };
  diamant: Awaited<ReturnType<typeof seedTenant>>;
  other: Awaited<ReturnType<typeof seedTenant>>;
  ownerToken: string;
  otherToken: string;
  close: () => Promise<void>;
  /** Adds a staff member and returns a token for them. */
  addMember: (role: Role, storeId?: string | null) => Promise<{ token: string; membershipId: string; userId: string }>;
}

export async function createHarness(): Promise<Harness> {
  const database: TestDatabase = await createTestDatabase(inject("pgAdminUrl"));
  const pool = createPool(database.url);
  const diamant = await seedTenant(pool, DIAMANT_TENANT_SEED, { firebaseUid: "uid-owner", email: "owner@x.test", displayName: "Owner" });
  const other = await seedTenant(pool, OTHER_SEED, { firebaseUid: "uid-other", email: "other@x.test", displayName: "Other" });
  // Every seeded register gets a (fake) card terminal.
  await pool.query(`UPDATE registers SET terminal_device_id = 'term-' || left(id::text, 8)`);

  const gateway = new FakePaymentGateway();
  const secrets = new StaticSecretProvider({
    "diamant-telecom/SHOPIFY_WEBHOOK_SECRET": "shopify-test-secret",
    "diamant-telecom/TWILIO_AUTH_TOKEN": "twilio-test-token",
    "diamant-telecom/TELEBROAD_WEBHOOK_TOKEN": "telebroad-test-token",
  });
  const clock = { now: new Date("2026-07-01T15:00:00Z") };
  const app = buildApp(
    {
      config: { NODE_ENV: "test", LOG_LEVEL: "silent", CORS_ORIGINS: "http://localhost:5173", PUBLIC_BASE_URL: "https://api.test" },
      pool,
      verifier: new DevTokenVerifier(DEV_SECRET),
      operatorTokens: new OperatorTokens("operator-secret-0123456789abcdefghijkl"),
      cipher: new FieldCipher(new EnvKeyProvider(`k1:${randomBytes(32).toString("base64")}`, "k1")),
      secrets,
      gatewayFor: async () => gateway,
      now: () => clock.now,
    },
    { logger: false },
  );
  await app.ready();

  const addMember: Harness["addMember"] = async (role, storeId = null) => {
    const uid = `uid-${role}-${randomUUID().slice(0, 8)}`;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (firebase_uid, email, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [uid, `${uid}@x.test`, `${role} person`],
    );
    const membership = await pool.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role, store_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [diamant.tenantId, user.rows[0]!.id, role, storeId],
    );
    return { token: await DevTokenVerifier.sign(DEV_SECRET, uid), membershipId: membership.rows[0]!.id, userId: user.rows[0]!.id };
  };

  return {
    app,
    pool,
    gateway,
    secrets,
    clock,
    diamant,
    other,
    ownerToken: await DevTokenVerifier.sign(DEV_SECRET, "uid-owner"),
    otherToken: await DevTokenVerifier.sign(DEV_SECRET, "uid-other"),
    addMember,
    close: async () => {
      await app.close();
      await pool.end();
      await database.drop();
    },
  };
}

export interface CallOptions {
  token: string;
  key?: string | null;
  registerId?: string;
  operatorToken?: string;
}

export async function call(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  opts: CallOptions,
  body?: unknown,
): Promise<LightMyRequestResponse & { data: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
  if (method === "POST" && opts.key !== null) headers["idempotency-key"] = opts.key ?? randomUUID();
  if (opts.registerId) headers["x-register-id"] = opts.registerId;
  if (opts.operatorToken) headers["x-operator-token"] = opts.operatorToken;
  const response = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
  let data: unknown = null;
  try {
    data = response.body ? JSON.parse(response.body) : null;
  } catch {
    data = response.body;
  }
  return Object.assign(response, { data });
}

/** Creates a product with one variant and receives stock into each store. */
export async function stockedProduct(
  h: Harness,
  opts: { sku: string; priceCents: number; qtyPerStore: number; stores?: string[]; serialized?: boolean },
): Promise<string> {
  const created = await call(h.app, "POST", "/api/v2/products", { token: h.ownerToken }, {
    name: `Item ${opts.sku}`,
    category: "Accessories",
    variants: [{ sku: opts.sku, priceCents: opts.priceCents, serialized: opts.serialized ?? false }],
  });
  if (created.statusCode !== 201) throw new Error(`product create failed: ${created.body}`);
  const variantId = created.data.variants[0].variantId as string;
  if (opts.qtyPerStore > 0) {
    for (const storeId of opts.stores ?? h.diamant.stores.map((s) => s.id)) {
      const received = await call(h.app, "POST", "/api/v2/stock/receive", { token: h.ownerToken }, {
        storeId,
        lines: [{ variantId, qty: opts.qtyPerStore }],
      });
      if (received.statusCode !== 201) throw new Error(`receive failed: ${received.body}`);
    }
  }
  return variantId;
}

export async function balance(h: Harness, storeId: string, variantId: string): Promise<number> {
  const row = await h.pool.query<{ qty: number }>(`SELECT qty FROM inventory_balances WHERE store_id = $1 AND variant_id = $2`, [
    storeId,
    variantId,
  ]);
  return row.rows[0]?.qty ?? 0;
}
