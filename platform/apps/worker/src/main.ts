import { EnvSecretProvider } from "@pos/adapters";
import { createPool } from "@pos/db";
import pino from "pino";
import { z } from "zod";
import { fakeProviders, secretProviders, type WorkerDeps } from "./deps.js";
import { reconcilePayments, rentalReturnReminders, tenants } from "./jobs.js";
import { processBatch } from "./outbox.js";

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    PROVIDERS: z.enum(["fake", "real"]).default("fake"),
    POLL_INTERVAL_MS: z.coerce.number().int().min(200).default(2000),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(15 * 60_000),
    REMINDER_INTERVAL_MS: z.coerce.number().int().min(60_000).default(60 * 60_000),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.PROVIDERS === "fake") {
      ctx.addIssue({ code: "custom", message: "PROVIDERS=fake is not allowed in production" });
    }
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { service: "worker" } });
const pool = createPool(env.DATABASE_URL);
const deps: WorkerDeps = {
  pool,
  providers: env.PROVIDERS === "fake" ? fakeProviders() : secretProviders(new EnvSecretProvider()),
  now: () => new Date(),
  log,
};

let stopping = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function outboxLoop() {
  while (!stopping) {
    try {
      const processed = await processBatch(deps);
      if (processed === 0) await sleep(env.POLL_INTERVAL_MS);
    } catch (error) {
      log.error({ err: error }, "outbox batch failed");
      await sleep(env.POLL_INTERVAL_MS * 5);
    }
  }
}

function every(intervalMs: number, name: string, job: () => Promise<unknown>) {
  const run = async () => {
    if (stopping) return;
    try {
      const result = await job();
      log.info({ job: name, result }, "scheduled job finished");
    } catch (error) {
      log.error({ err: error, job: name }, "scheduled job failed");
    }
  };
  void run();
  return setInterval(run, intervalMs);
}

const timers = [
  every(env.RECONCILE_INTERVAL_MS, "reconcile_payments", async () => {
    const out: Record<string, unknown> = {};
    for (const tenant of await tenants(deps)) out[tenant.slug] = await reconcilePayments(deps, tenant);
    return out;
  }),
  every(env.REMINDER_INTERVAL_MS, "rental_return_reminders", async () => {
    let queued = 0;
    for (const tenant of await tenants(deps)) queued += await rentalReturnReminders(deps, tenant);
    return { queued };
  }),
];

const loop = outboxLoop();
log.info({ providers: env.PROVIDERS }, "worker started");

const shutdown = async () => {
  stopping = true;
  timers.forEach(clearInterval);
  await loop;
  await pool.end();
  log.info({}, "worker stopped");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
