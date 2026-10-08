import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";
import { runMigrations } from "./index.js";

/**
 * Test Postgres. If TEST_DATABASE_URL points at a server (docker compose, CI
 * service container), it is used. Otherwise a real PostgreSQL 17 is started
 * from the `embedded-postgres` binaries — no Docker or admin rights needed.
 * Each test file gets its own freshly migrated database.
 */
export interface TestServer {
  adminUrl: string;
  stop: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) return { adminUrl: external, stop: async () => undefined };

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = 54_000 + Math.floor(Math.random() * 1000);
  const databaseDir = path.join(os.tmpdir(), `pos-pg-${process.pid}-${randomBytes(3).toString("hex")}`);
  const server = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  return {
    adminUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      fs.rmSync(databaseDir, { recursive: true, force: true });
    },
  };
}

export interface TestDatabase {
  url: string;
  drop: () => Promise<void>;
}

export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return {
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}
