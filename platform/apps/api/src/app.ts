import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { authenticate } from "./lib/auth.js";
import type { Deps } from "./lib/deps.js";
import { AppError, errorHandler } from "./lib/errors.js";
import { registerCustomers } from "./modules/customers.js";
import { registerMe } from "./modules/me.js";
import { registerOperations } from "./modules/operations.js";
import { registerPayments } from "./modules/payments.js";
import { registerRentals } from "./modules/rentals.js";
import { registerSales } from "./modules/sales.js";
import { registerStock } from "./modules/stock.js";
import { registerWebhooks } from "./modules/webhooks.js";
import { registerWorkOrders } from "./modules/workOrders.js";

const REQUEST_ID_RE = /^[A-Za-z0-9_\-]{8,64}$/;

export function buildApp(deps: Deps, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers['x-operator-token']",
                "req.headers['x-twilio-signature']",
                "req.headers['x-shopify-hmac-sha256']",
                "req.headers['x-webhook-token']",
              ],
              censor: "[redacted]",
            },
          },
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
    bodyLimit: 1_000_000,
    trustProxy: true,
  });

  app.decorateRequest("auth", null);

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    request.rawBody = text;
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError("VALIDATION_FAILED", "Body is not valid JSON"), undefined);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    request.rawBody = text;
    done(null, Object.fromEntries(new URLSearchParams(text)));
  });

  const allowedOrigins = new Set(
    deps.config.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header(
        "access-control-allow-headers",
        "authorization, content-type, idempotency-key, x-tenant-id, x-register-id, x-operator-token, x-request-id",
      );
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("access-control-expose-headers", "x-request-id, idempotent-replayed");
      reply.header("access-control-max-age", "600");
    }
    if (request.method === "OPTIONS") return reply.status(204).send();
  });

  app.addHook("preHandler", async (request) => {
    const url = request.url;
    if (!url.startsWith("/api/v2/") || url.startsWith("/api/v2/webhooks/")) return;
    request.auth = await authenticate(request, deps);
    request.log = request.log.child({
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      operatorMembershipId: request.auth.operator?.membershipId,
      registerId: request.auth.registerId,
    });
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such endpoint", requestId: String(request.id) } }),
  );

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => {
    await deps.pool.query("SELECT 1");
    return { ok: true };
  });

  registerMe(app, deps);
  registerSales(app, deps);
  registerPayments(app, deps);
  registerWorkOrders(app, deps);
  registerStock(app, deps);
  registerCustomers(app, deps);
  registerRentals(app, deps);
  registerOperations(app, deps);
  registerWebhooks(app, deps);

  return app;
}
