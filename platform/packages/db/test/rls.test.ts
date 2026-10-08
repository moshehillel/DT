import { DIAMANT_TENANT_SEED, type TenantSeed } from "@pos/domain";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, seedTenant, withAppRole, withTenant, type Pool } from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

const OTHER: TenantSeed = {
  ...DIAMANT_TENANT_SEED,
  slug: "other-shop",
  name: "Other Shop",
  stores: [{ ...DIAMANT_TENANT_SEED.stores[0]!, code: "OTH", name: "Other main" }],
};

describe("row-level security", () => {
  let database: TestDatabase;
  let pool: Pool;
  let a: Awaited<ReturnType<typeof seedTenant>>;
  let b: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    database = await createTestDatabase(inject("pgAdminUrl"));
    pool = createPool(database.url);
    a = await seedTenant(pool, DIAMANT_TENANT_SEED, { firebaseUid: "uid-a", email: "a@x.test", displayName: "A" });
    b = await seedTenant(pool, OTHER, { firebaseUid: "uid-b", email: "b@x.test", displayName: "B" });
    await pool.query(`INSERT INTO customers (tenant_id, phone, name) VALUES ($1,'+13475550001','Alice'), ($2,'+13475550002','Bob')`, [
      a.tenantId,
      b.tenantId,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  it("tenant A cannot read tenant B rows, even without a WHERE clause", async () => {
    const rows = await withTenant(pool, { tenantId: a.tenantId }, async ({ client }) => {
      const customers = await client.query(`SELECT name FROM customers`);
      const stores = await client.query(`SELECT code FROM stores`);
      const tenants = await client.query(`SELECT slug FROM tenants`);
      return { customers: customers.rows, stores: stores.rows, tenants: tenants.rows };
    });
    expect(rows.customers).toEqual([{ name: "Alice" }]);
    expect(rows.stores.map((s) => s.code).sort()).toEqual(["BKN", "CAT", "UPS"]);
    expect(rows.tenants).toEqual([{ slug: "diamant-telecom" }]);
  });

  it("tenant A cannot write rows into tenant B", async () => {
    await expect(
      withTenant(pool, { tenantId: a.tenantId }, ({ client }) =>
        client.query(`INSERT INTO customers (tenant_id, phone) VALUES ($1, '+13475550003')`, [b.tenantId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("tenant A cannot update or delete tenant B rows", async () => {
    const result = await withTenant(pool, { tenantId: a.tenantId }, async ({ client }) => {
      const upd = await client.query(`UPDATE customers SET name = 'hacked' WHERE phone = '+13475550002'`);
      const del = await client.query(`DELETE FROM customers WHERE phone = '+13475550002'`);
      return { updated: upd.rowCount, deleted: del.rowCount };
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
    const bob = await pool.query(`SELECT name FROM customers WHERE phone = '+13475550002'`);
    expect(bob.rows[0].name).toBe("Bob");
  });

  it("no tenant selected means no rows", async () => {
    const rows = await withAppRole(pool, (client) => client.query(`SELECT * FROM customers`));
    expect(rows.rowCount).toBe(0);
  });

  it("ledgers are append-only for the app role", async () => {
    await withTenant(pool, { tenantId: a.tenantId }, ({ client }) =>
      client.query(`INSERT INTO audit_log (tenant_id, action, entity_type) VALUES ($1, 'test', 'test')`, [a.tenantId]),
    );
    await expect(
      withTenant(pool, { tenantId: a.tenantId }, ({ client }) => client.query(`DELETE FROM audit_log`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("auth lookup resolves memberships across tenants only through the definer function", async () => {
    const rows = await withAppRole(pool, (client) => client.query(`SELECT tenant_id, role FROM app_auth_lookup('uid-b')`));
    expect(rows.rows).toEqual([{ tenant_id: b.tenantId, role: "owner" }]);
    const users = await withAppRole(pool, (client) => client.query(`SELECT * FROM users`));
    expect(users.rowCount).toBe(0);
  });
});
