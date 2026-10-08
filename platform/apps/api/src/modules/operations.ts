import { randomUUID } from "node:crypto";
import {
  AssignPhoneOrderCommand,
  CashMovementCommand,
  CloseShiftCommand,
  CreatePhoneOrderCommand,
  DeliverPhoneOrderCommand,
  OpenShiftCommand,
  PinSwitchCommand,
  SetPinCommand,
} from "@pos/contracts";
import { ROLES, roleHas, type Role } from "@pos/domain";
import { isUniqueViolation, withTenant } from "@pos/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { effective, requirePermission, requireStoreAccess } from "../lib/auth.js";
import { command, query } from "../lib/command.js";
import { hashPin, verifyPin } from "../lib/crypto.js";
import type { Deps } from "../lib/deps.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import { getCustomer } from "../services/customers.js";
import { queueCustomerMessage } from "../services/notifications.js";
import { loadStore, loadTenant } from "../services/tenant.js";

/** In-memory PIN attempt limiter (per membership). Swap for Redis when running more than one API instance. */
const pinFailures = new Map<string, { count: number; until: number }>();

export function registerOperations(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------- shifts
  app.post(
    "/api/v2/shifts",
    command(deps, { permission: "shift.operate", schema: OpenShiftCommand }, async ({ auth, tx }, body) => {
      const register = await tx.client.query<{ store_id: string }>(`SELECT store_id FROM registers WHERE id = $1`, [body.registerId]);
      if (!register.rows[0]) throw notFound("Register");
      requireStoreAccess(auth, register.rows[0].store_id);
      const id = randomUUID();
      try {
        await tx.client.query(`SAVEPOINT shift`);
        await tx.client.query(
          `INSERT INTO shifts (id, tenant_id, store_id, register_id, opening_float_cents, opened_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, auth.tenantId, register.rows[0].store_id, body.registerId, body.openingFloatCents, auth.userId],
        );
        await tx.client.query(`RELEASE SAVEPOINT shift`);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError("CONFLICT", "This register already has an open shift");
        throw error;
      }
      return {
        status: 201,
        body: { id, registerId: body.registerId, status: "open", openingFloatCents: body.openingFloatCents },
        audit: { action: "shift.open", entityType: "shift", entityId: id, storeId: register.rows[0].store_id, data: { ...body } },
      };
    }),
  );

  app.post(
    "/api/v2/shifts/:id/cash-movements",
    command<typeof CashMovementCommand, { id: string }>(
      deps,
      { permission: "shift.operate", schema: CashMovementCommand },
      async ({ auth, tx, params }, body) => {
        const shift = await tx.client.query<{ store_id: string; status: string }>(`SELECT store_id, status FROM shifts WHERE id = $1`, [
          params.id,
        ]);
        const row = shift.rows[0];
        if (!row) throw notFound("Shift");
        requireStoreAccess(auth, row.store_id);
        if (row.status !== "open") throw new AppError("CONFLICT", "This shift is closed");
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO cash_movements (id, tenant_id, shift_id, kind, amount_cents, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, auth.tenantId, params.id, body.amountCents > 0 ? "paid_in" : "paid_out", body.amountCents, body.reason, auth.userId],
        );
        return {
          status: 201,
          body: { id },
          audit: { action: "shift.cash_movement", entityType: "shift", entityId: params.id, storeId: row.store_id, data: { ...body } },
        };
      },
    ),
  );

  app.post(
    "/api/v2/shifts/:id/close",
    command<typeof CloseShiftCommand, { id: string }>(
      deps,
      { permission: "shift.operate", schema: CloseShiftCommand },
      async ({ auth, tx, params }, body) => {
        const shift = await tx.client.query<{ store_id: string; status: string; opening_float_cents: number }>(
          `SELECT store_id, status, opening_float_cents FROM shifts WHERE id = $1 FOR UPDATE`,
          [params.id],
        );
        const row = shift.rows[0];
        if (!row) throw notFound("Shift");
        requireStoreAccess(auth, row.store_id);
        if (row.status !== "open") throw new AppError("CONFLICT", "This shift is already closed");
        const sum = await tx.client.query<{ total: number }>(
          `SELECT coalesce(sum(amount_cents),0)::int AS total FROM cash_movements WHERE shift_id = $1`,
          [params.id],
        );
        const expected = row.opening_float_cents + sum.rows[0]!.total;
        await tx.client.query(
          `UPDATE shifts SET status = 'closed', closed_at = now(), closed_by = $2, counted_cash_cents = $3, expected_cash_cents = $4,
                  note = $5, version = version + 1 WHERE id = $1`,
          [params.id, auth.userId, body.countedCashCents, expected, body.note ?? null],
        );
        return {
          status: 200,
          body: { id: params.id, expectedCashCents: expected, countedCashCents: body.countedCashCents, overShortCents: body.countedCashCents - expected },
          audit: { action: "shift.close", entityType: "shift", entityId: params.id, storeId: row.store_id, data: { expected, counted: body.countedCashCents } },
        };
      },
    ),
  );

  // ------------------------------------------------------------- phone orders & deliveries
  app.post(
    "/api/v2/phone-orders",
    command(deps, { permission: "phone_order.write", schema: CreatePhoneOrderCommand }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.storeId);
      await loadStore(tx, body.storeId);
      await getCustomer(tx, body.customerId);
      const id = randomUUID();
      await tx.client.query(
        `INSERT INTO phone_orders (id, tenant_id, store_id, customer_id, model, address, amount_cents, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, auth.tenantId, body.storeId, body.customerId, body.model, body.address, body.amountCents, body.notes ?? null, auth.userId],
      );
      return { status: 201, body: { id, status: "new", version: 1 }, audit: { action: "phone_order.create", entityType: "phone_order", entityId: id, storeId: body.storeId } };
    }),
  );

  app.post(
    "/api/v2/phone-orders/:id/assign",
    command<typeof AssignPhoneOrderCommand, { id: string }>(
      deps,
      { permission: "phone_order.write", schema: AssignPhoneOrderCommand },
      async ({ auth, tx, params }, body) => {
        const tenant = await loadTenant(tx);
        const order = await tx.client.query<{ store_id: string; version: number; status: string; model: string; phone: string }>(
          `SELECT o.store_id, o.version, o.status, o.model, c.phone FROM phone_orders o JOIN customers c ON c.id = o.customer_id
            WHERE o.id = $1 FOR UPDATE OF o`,
          [params.id],
        );
        const row = order.rows[0];
        if (!row) throw notFound("Phone order");
        requireStoreAccess(auth, row.store_id);
        if (row.version !== body.expectedVersion) throw new AppError("VERSION_MISMATCH", "This order changed — reload it");
        if (row.status === "delivered" || row.status === "cancelled") throw new AppError("INVALID_TRANSITION", `Order is ${row.status}`);
        const driver = await tx.client.query<{ display_name: string; role: Role }>(
          `SELECT u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.active`,
          [body.driverMembershipId],
        );
        if (!driver.rows[0]) throw notFound("Driver");
        await tx.client.query(
          `UPDATE phone_orders SET status = 'assigned', driver_membership_id = $2, version = version + 1 WHERE id = $1`,
          [params.id, body.driverMembershipId],
        );
        await tx.client.query(
          `INSERT INTO deliveries (tenant_id, phone_order_id, driver_membership_id, status, created_by) VALUES ($1,$2,$3,'assigned',$4)`,
          [auth.tenantId, params.id, body.driverMembershipId, auth.userId],
        );
        await queueCustomerMessage(tx, auth.tenantId, {
          dedupeKey: `phone_order:${params.id}:assigned:${row.version + 1}`,
          template: "phone_order_assigned",
          to: row.phone,
          vars: { company: tenant.name, model: row.model, assignee: driver.rows[0].display_name.split(" ")[0] ?? "our team" },
        });
        return {
          status: 200,
          body: { id: params.id, status: "assigned", version: row.version + 1 },
          audit: { action: "phone_order.assign", entityType: "phone_order", entityId: params.id, storeId: row.store_id, data: { ...body } },
        };
      },
    ),
  );

  app.post(
    "/api/v2/phone-orders/:id/deliver",
    command<typeof DeliverPhoneOrderCommand, { id: string }>(
      deps,
      { permission: "phone_order.deliver", schema: DeliverPhoneOrderCommand },
      async ({ auth, tx, params }, body) => {
        const tenant = await loadTenant(tx);
        const order = await tx.client.query<{
          store_id: string;
          version: number;
          status: string;
          model: string;
          phone: string;
          driver_membership_id: string | null;
        }>(
          `SELECT o.store_id, o.version, o.status, o.model, c.phone, o.driver_membership_id
             FROM phone_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1 FOR UPDATE OF o`,
          [params.id],
        );
        const row = order.rows[0];
        if (!row) throw notFound("Phone order");
        const me = effective(auth);
        // Drivers can only close their own deliveries; managers can close any.
        if (me.role === "driver" && row.driver_membership_id !== me.membershipId) throw forbidden("This delivery is not assigned to you");
        if (row.version !== body.expectedVersion) throw new AppError("VERSION_MISMATCH", "This order changed — reload it");
        if (row.status !== "assigned") throw new AppError("INVALID_TRANSITION", "Only assigned orders can be delivered");
        await tx.client.query(`UPDATE phone_orders SET status = 'delivered', delivered_at = now(), version = version + 1 WHERE id = $1`, [
          params.id,
        ]);
        await tx.client.query(
          `INSERT INTO deliveries (tenant_id, phone_order_id, driver_membership_id, status, created_by) VALUES ($1,$2,$3,'delivered',$4)`,
          [auth.tenantId, params.id, row.driver_membership_id, auth.userId],
        );
        await queueCustomerMessage(tx, auth.tenantId, {
          dedupeKey: `phone_order:${params.id}:delivered`,
          template: "phone_order_delivered",
          to: row.phone,
          vars: { company: tenant.name, model: row.model },
        });
        return {
          status: 200,
          body: { id: params.id, status: "delivered", version: row.version + 1 },
          audit: { action: "phone_order.deliver", entityType: "phone_order", entityId: params.id, storeId: row.store_id },
        };
      },
    ),
  );

  app.get(
    "/api/v2/phone-orders",
    query<Record<string, string>, { status?: string }>(deps, "customer.read", async ({ auth, tx, query: q }) => {
      const me = effective(auth);
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`o.status = $${params.length}`);
      } else {
        where.push(`o.status IN ('new','assigned')`);
      }
      if (me.role === "driver") {
        params.push(me.membershipId);
        where.push(`o.driver_membership_id = $${params.length}`);
      } else if (!roleHas(me.role, "phone_order.write")) {
        throw forbidden();
      }
      const rows = await tx.client.query(
        `SELECT o.id, o.status, o.model, o.address, o.amount_cents, o.version, o.created_at, c.phone, c.name
           FROM phone_orders o JOIN customers c ON c.id = o.customer_id WHERE ${where.join(" AND ")}
          ORDER BY o.created_at DESC LIMIT 200`,
        params,
      );
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          status: r.status,
          model: r.model,
          address: r.address,
          amountCents: r.amount_cents,
          version: r.version,
          customerPhone: r.phone,
          customerName: r.name,
          createdAt: r.created_at.toISOString(),
        })),
        nextCursor: null,
      };
    }),
  );

  // ------------------------------------------------------------- staff & PIN switch
  app.post(
    "/api/v2/staff",
    command(
      deps,
      {
        permission: "staff.manage",
        schema: z.object({
          firebaseUid: z.string().min(6).max(128),
          email: z.string().email().optional(),
          displayName: z.string().min(1).max(120),
          role: z.enum(ROLES),
          storeId: z.string().uuid().optional(),
        }),
      },
      async ({ auth, tx }, body) => {
        if (body.role === "owner" && effective(auth).role !== "owner") throw forbidden("Only an owner can add an owner");
        if (body.storeId) await loadStore(tx, body.storeId);
        const user = await tx.client.query<{ id: string }>(`SELECT app_upsert_user($1,$2,$3) AS id`, [
          body.firebaseUid,
          body.email ?? null,
          body.displayName,
        ]);
        const membership = await tx.client.query<{ id: string }>(
          `INSERT INTO memberships (tenant_id, user_id, role, store_id, created_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, store_id = EXCLUDED.store_id, active = true,
             version = memberships.version + 1
           RETURNING id`,
          [auth.tenantId, user.rows[0]!.id, body.role, body.storeId ?? null, auth.userId],
        );
        return {
          status: 201,
          body: { membershipId: membership.rows[0]!.id },
          audit: { action: "staff.upsert", entityType: "membership", entityId: membership.rows[0]!.id, data: { role: body.role, storeId: body.storeId } },
        };
      },
    ),
  );

  app.post(
    "/api/v2/staff/:membershipId/pin",
    command<typeof SetPinCommand, { membershipId: string }>(
      deps,
      { permission: "shift.operate", schema: SetPinCommand },
      async ({ auth, tx, params }, body) => {
        const self = params.membershipId === (auth.operator?.membershipId ?? auth.member.membershipId);
        if (!self) requirePermission(auth, "staff.manage");
        const updated = await tx.client.query(`UPDATE memberships SET pin_hash = $2, version = version + 1 WHERE id = $1`, [
          params.membershipId,
          await hashPin(body.pin),
        ]);
        if (!updated.rowCount) throw notFound("Staff member");
        return {
          status: 204,
          body: null,
          audit: { action: "staff.set_pin", entityType: "membership", entityId: params.membershipId },
        };
      },
    ),
  );

  app.get(
    "/api/v2/staff/switchable",
    query(deps, "shift.operate", async ({ tx }) => {
      const rows = await tx.client.query(
        `SELECT m.id, m.role, m.store_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.active AND m.pin_hash IS NOT NULL ORDER BY u.display_name`,
      );
      return { items: rows.rows.map((r) => ({ membershipId: r.id, role: r.role, storeId: r.store_id, displayName: r.display_name })) };
    }),
  );

  /** Till PIN switch: the device stays signed in; the cashier gets a 12h operator token. */
  app.post("/api/v2/auth/pin-switch", async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw new AppError("UNAUTHENTICATED", "Sign in required");
    const parsed = PinSwitchCommand.safeParse(request.body ?? {});
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Choose a staff member and enter a 4-8 digit PIN");
    const body = parsed.data;
    const lock = pinFailures.get(body.membershipId);
    if (lock && lock.until > Date.now()) throw new AppError("RATE_LIMITED", "Too many wrong PINs. Wait a few minutes.");
    const target = await withTenant(deps.pool, { tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.client.query<{ pin_hash: string | null; role: Role; display_name: string }>(
        `SELECT m.pin_hash, m.role, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.active`,
        [body.membershipId],
      );
      return row.rows[0];
    });
    const ok = target ? await verifyPin(body.pin, target.pin_hash) : false;
    await withTenant(deps.pool, { tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      tx.client.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_membership_id, operator_membership_id, action, entity_type, entity_id, request_id)
         VALUES ($1,$2,$3,$4,$5,'membership',$6,$7)`,
        [
          auth.tenantId,
          auth.userId,
          auth.member.membershipId,
          body.membershipId,
          ok ? "auth.pin_switch" : "auth.pin_switch_failed",
          body.membershipId,
          String(request.id),
        ],
      ),
    );
    if (!ok || !target) {
      const current = pinFailures.get(body.membershipId) ?? { count: 0, until: 0 };
      current.count += 1;
      if (current.count >= 5) {
        current.until = Date.now() + 5 * 60_000;
        current.count = 0;
      }
      pinFailures.set(body.membershipId, current);
      throw new AppError("UNAUTHENTICATED", "Wrong PIN");
    }
    pinFailures.delete(body.membershipId);
    const token = await deps.operatorTokens.sign({ tenantId: auth.tenantId, membershipId: body.membershipId, deviceUserId: auth.userId });
    return reply.send({ operatorToken: token, membershipId: body.membershipId, role: target.role, displayName: target.display_name });
  });
}
