import { roleHas, type Permission, type Role } from "@pos/domain";
import { withAppRole, withTenant, type Pool } from "@pos/db";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { AppError, forbidden } from "./errors.js";

export interface VerifiedIdentity {
  uid: string;
  email: string | null;
  name: string | null;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

/**
 * Firebase / Identity Platform ID tokens: RS256, issuer
 * https://securetoken.google.com/<project>, audience <project>, keys from
 * Google's JWKS. Verified locally — no firebase-admin dependency.
 */
export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly jwks = createRemoteJWKSet(
    new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
  );

  constructor(private readonly projectId: string) {}

  async verify(token: string): Promise<VerifiedIdentity> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: `https://securetoken.google.com/${this.projectId}`,
      audience: this.projectId,
      algorithms: ["RS256"],
    });
    if (!payload.sub) throw new Error("token has no subject");
    return {
      uid: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  }
}

/** Local/test only (refused in production by config): HS256 tokens signed with DEV_AUTH_SECRET. */
export class DevTokenVerifier implements TokenVerifier {
  private readonly key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], issuer: "pos-dev" });
    if (!payload.sub) throw new Error("token has no subject");
    return { uid: payload.sub, email: (payload.email as string) ?? null, name: (payload.name as string) ?? null };
  }

  static async sign(secret: string, uid: string, extra: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT(extra)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(uid)
      .setIssuer("pos-dev")
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(new TextEncoder().encode(secret));
  }
}

export interface MembershipRef {
  membershipId: string;
  role: Role;
  storeId: string | null;
}

export interface AuthContext {
  userId: string;
  uid: string;
  displayName: string;
  tenantId: string;
  tenantName: string;
  /** The signed-in account (often a store device / manager). */
  member: MembershipRef;
  /** Set after a till PIN switch: the cashier actually ringing. Permissions follow the operator. */
  operator: (MembershipRef & { userId: string; displayName: string }) | null;
  registerId: string | null;
}

export function effective(ctx: AuthContext): MembershipRef {
  return ctx.operator ?? ctx.member;
}

export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!roleHas(effective(ctx).role, permission)) throw forbidden(`Your role cannot perform ${permission}`);
}

/** Store-scoped memberships may only act on their own store. */
export function requireStoreAccess(ctx: AuthContext, storeId: string | null | undefined): void {
  const scope = effective(ctx).storeId;
  if (scope && storeId && scope !== storeId) throw forbidden("You can only work in your own store");
}

export class OperatorTokens {
  private readonly key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: { tenantId: string; membershipId: string; deviceUserId: string }): Promise<string> {
    return new SignJWT({ tid: claims.tenantId, mid: claims.membershipId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.deviceUserId)
      .setIssuer("pos-operator")
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(this.key);
  }

  async verify(token: string): Promise<{ tenantId: string; membershipId: string; deviceUserId: string }> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], issuer: "pos-operator" });
    return { tenantId: String(payload.tid), membershipId: String(payload.mid), deviceUserId: String(payload.sub) };
  }
}

interface LookupRow {
  user_id: string;
  display_name: string;
  membership_id: string;
  tenant_id: string;
  tenant_name: string;
  role: Role;
  store_id: string | null;
}

export async function authenticate(
  request: FastifyRequest,
  deps: { pool: Pool; verifier: TokenVerifier; operatorTokens: OperatorTokens },
): Promise<AuthContext> {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError("UNAUTHENTICATED", "Sign in required");

  let identity: VerifiedIdentity;
  try {
    identity = await deps.verifier.verify(token);
  } catch {
    throw new AppError("UNAUTHENTICATED", "Your session is invalid or expired. Sign in again.");
  }

  const rows = await withAppRole(deps.pool, async (client) => {
    const result = await client.query<LookupRow>(`SELECT * FROM app_auth_lookup($1)`, [identity.uid]);
    return result.rows;
  });
  if (rows.length === 0) throw forbidden("This account has no access to any shop");

  const requestedTenant = String(request.headers["x-tenant-id"] ?? "");
  const row = requestedTenant ? rows.find((r) => r.tenant_id === requestedTenant) : rows.length === 1 ? rows[0] : undefined;
  if (!row) {
    throw new AppError("FORBIDDEN", requestedTenant ? "No access to that shop" : "Choose a shop (X-Tenant-Id)", {
      tenants: rows.map((r) => ({ id: r.tenant_id, name: r.tenant_name })),
    });
  }

  const ctx: AuthContext = {
    userId: row.user_id,
    uid: identity.uid,
    displayName: row.display_name,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    member: { membershipId: row.membership_id, role: row.role, storeId: row.store_id },
    operator: null,
    registerId: typeof request.headers["x-register-id"] === "string" ? request.headers["x-register-id"] : null,
  };

  const operatorToken = request.headers["x-operator-token"];
  if (typeof operatorToken === "string" && operatorToken) {
    let claims: Awaited<ReturnType<OperatorTokens["verify"]>>;
    try {
      claims = await deps.operatorTokens.verify(operatorToken);
    } catch {
      throw new AppError("UNAUTHENTICATED", "Cashier session expired. Enter your PIN again.");
    }
    if (claims.tenantId !== ctx.tenantId || claims.deviceUserId !== ctx.userId) {
      throw new AppError("UNAUTHENTICATED", "Cashier session does not belong to this device");
    }
    const op = await withTenant(deps.pool, { tenantId: ctx.tenantId, userId: ctx.userId }, async ({ client }) => {
      const result = await client.query<{ id: string; role: Role; store_id: string | null; user_id: string; display_name: string }>(
        `SELECT m.id, m.role, m.store_id, m.user_id, u.display_name
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.id = $1 AND m.active`,
        [claims.membershipId],
      );
      return result.rows[0];
    });
    if (!op) throw new AppError("UNAUTHENTICATED", "Cashier is no longer active");
    ctx.operator = { membershipId: op.id, role: op.role, storeId: op.store_id, userId: op.user_id, displayName: op.display_name };
  }

  return ctx;
}
