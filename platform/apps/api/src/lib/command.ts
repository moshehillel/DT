import type { Permission } from "@pos/domain";
import { withTenant, type TxHandle } from "@pos/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { requirePermission, type AuthContext } from "./auth.js";
import { canonicalJson, sha256Hex } from "./crypto.js";
import type { Deps } from "./deps.js";
import { AppError } from "./errors.js";

export interface CommandResult {
  status: number;
  body: unknown;
  audit: { action: string; entityType: string; entityId: string | null; storeId?: string | null; data?: Record<string, unknown> };
}

export interface CommandContext<P> {
  auth: AuthContext;
  params: P;
  tx: TxHandle;
  requestId: string;
  deps: Deps;
}

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export function idempotencyKeyFrom(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Every write needs an Idempotency-Key header (8-128 chars)");
  }
  return key;
}

export async function writeAudit(
  tx: TxHandle,
  auth: AuthContext,
  requestId: string,
  ip: string | null,
  audit: CommandResult["audit"],
): Promise<void> {
  await tx.client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, actor_membership_id, operator_membership_id, action, entity_type,
                            entity_id, request_id, store_id, register_id, ip, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      auth.tenantId,
      auth.userId,
      auth.member.membershipId,
      auth.operator?.membershipId ?? null,
      audit.action,
      audit.entityType,
      audit.entityId,
      requestId,
      audit.storeId ?? null,
      auth.registerId && /^[0-9a-f-]{36}$/i.test(auth.registerId) ? auth.registerId : null,
      ip,
      JSON.stringify(audit.data ?? {}),
    ],
  );
}

/**
 * Every write endpoint goes through here:
 *   auth -> permission -> Zod validation -> Idempotency-Key -> one transaction
 *   (advisory lock on the key, replay if already applied, handler, audit row,
 *   stored response) -> typed response.
 * Because the idempotency row commits in the same transaction as the effects,
 * a replay can never apply a sale twice, and a failed attempt leaves nothing
 * behind so the client can safely retry with the same key.
 */
export function command<S extends z.ZodTypeAny, P = Record<string, string>>(
  deps: Deps,
  options: { permission: Permission; schema: S },
  handler: (ctx: CommandContext<P>, body: z.infer<S>) => Promise<CommandResult>,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
    requirePermission(auth, options.permission);
    const key = idempotencyKeyFrom(request);
    const parsed = options.schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Request validation failed",
        parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
    const requestHash = sha256Hex(`${route}\n${canonicalJson(request.params)}\n${canonicalJson(parsed.data)}`);
    const requestId = String(request.id);

    const outcome = await withTenant(deps.pool, { tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      await tx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${auth.tenantId}:${key}`]);
      const existing = await tx.client.query<{ request_hash: string; response_status: number; response_body: unknown }>(
        `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
        }
        return { replayed: true, status: prior.response_status, body: prior.response_body };
      }
      const result = await handler({ auth, params: request.params as P, tx, requestId, deps }, parsed.data);
      await writeAudit(tx, auth, requestId, request.ip ?? null, result.audit);
      await tx.client.query(
        `INSERT INTO idempotency_keys (tenant_id, key, user_id, route, request_hash, response_status, response_body)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [auth.tenantId, key, auth.userId, route, requestHash, result.status, JSON.stringify(result.body ?? null)],
      );
      return { replayed: false, status: result.status, body: result.body };
    });

    if (outcome.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(outcome.status).send(outcome.body);
  };
}

/** Reads: auth + permission + one read-only tenant transaction. */
export function query<P = Record<string, string>, Q = Record<string, string>>(
  deps: Deps,
  permission: Permission,
  handler: (ctx: { auth: AuthContext; params: P; query: Q; tx: TxHandle; requestId: string; ip: string | null }) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
    requirePermission(auth, permission);
    const body = await withTenant(deps.pool, { tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      handler({
        auth,
        params: request.params as P,
        query: request.query as Q,
        tx,
        requestId: String(request.id),
        ip: request.ip ?? null,
      }),
    );
    return reply.send(body);
  };
}
