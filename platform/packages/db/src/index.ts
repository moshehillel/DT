import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export { seedTenant, type SeedOwner } from "./seed.js";

export type Db = NodePgDatabase<typeof schema>;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// node-postgres returns DATE columns as JS Dates in local time by default; keep them as "YYYY-MM-DD".
pg.types.setTypeParser(1082, (value: string) => value);
// bigint (int8) -> number. Only audit_log ids and counts use it, well within 2^53.
pg.types.setTypeParser(20, (value: string) => Number(value));

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: "pos-platform" });
}

export interface TenantContext {
  tenantId: string;
  userId?: string | null;
}

export interface TxHandle {
  db: Db;
  client: pg.PoolClient;
}

/**
 * Run `fn` in one transaction as `app_user` with the tenant pinned. All
 * application data access goes through here, so row-level security applies
 * even if a query forgets its tenant filter.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
      ctx.tenantId,
      ctx.userId ?? "",
    ]);
    const db = drizzle(client, { schema });
    const result = await fn({ db, client });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** As app_user but with no tenant selected — only the SECURITY DEFINER entry points return anything. */
export async function withAppRole<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies versioned migrations as the connecting (owner) role. */
export async function runMigrations(connectionString: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const err = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const target = err?.code ? err : err?.cause;
  if (target?.code !== "23505") return false;
  return constraint ? target.constraint === constraint : true;
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const err = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const target = err?.code ? err : err?.cause;
  if (target?.code !== "23514") return false;
  return constraint ? target.constraint === constraint : true;
}
