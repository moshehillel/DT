import { randomUUID } from "node:crypto";
import { CreateWorkOrderCommand, ReserveTicketBlockCommand, UpdateWorkOrderStatusCommand } from "@pos/contracts";
import {
  canTransition,
  formatMoney,
  isOpenStatus,
  normalizeImei,
  normalizeUsPhone,
  parseTicketInput,
  planBlock,
  readyNotificationPlan,
  repairTotals,
  roleHas,
  shouldClearSecrets,
  type WorkOrderStatus,
} from "@pos/domain";
import type { TxHandle } from "@pos/db";
import type { FastifyInstance } from "fastify";
import { effective, requireStoreAccess } from "../lib/auth.js";
import { command, query, writeAudit } from "../lib/command.js";
import type { Deps } from "../lib/deps.js";
import { AppError, notFound } from "../lib/errors.js";
import { cancelPending } from "../lib/outbox.js";
import { decodeCursor, pageLimit, toPage } from "../lib/pagination.js";
import { upsertCustomer } from "../services/customers.js";
import { queueCustomerMessage } from "../services/notifications.js";
import { loadStore, loadTenant } from "../services/tenant.js";

interface WorkOrderRow {
  id: string;
  ticket_number: number;
  store_id: string;
  customer_id: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  model: string;
  imei: string | null;
  issue: string;
  fixes: { description: string; priceCents: number }[];
  estimate_cents: number | null;
  final_price_cents: number | null;
  paid_cents: number;
  status: WorkOrderStatus;
  notify_by: "sms" | "voice" | "both";
  ready_notify_at: Date | null;
  expected_ready_date: string | null;
  device_passcode_enc: string | null;
  account_pin_enc: string | null;
  had_sim: boolean;
  had_sd_card: boolean;
  loaner_given: boolean;
  notes: string | null;
  version: number;
  created_at: Date;
  created_by: string | null;
}

const COLUMNS = `id, ticket_number, store_id, customer_id, customer_phone, customer_name, model, imei, issue, fixes, estimate_cents,
  final_price_cents, paid_cents, status, notify_by, ready_notify_at, expected_ready_date, device_passcode_enc, account_pin_enc,
  had_sim, had_sd_card, loaner_given, notes, version, created_at, created_by`;

export function toWorkOrderDto(row: WorkOrderRow) {
  const totals = repairTotals({ finalPriceCents: row.final_price_cents, estimateCents: row.estimate_cents, fixes: row.fixes });
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    storeId: row.store_id,
    customerId: row.customer_id,
    customerPhone: row.customer_phone,
    customerName: row.customer_name,
    model: row.model,
    imei: row.imei,
    issue: row.issue,
    fixes: row.fixes,
    estimateCents: row.estimate_cents,
    finalPriceCents: row.final_price_cents,
    totalCents: totals.totalCents,
    paidCents: row.paid_cents,
    status: row.status,
    readyNotifyAt: row.ready_notify_at ? row.ready_notify_at.toISOString() : null,
    expectedReadyDate: row.expected_ready_date,
    hasDevicePasscode: Boolean(row.device_passcode_enc),
    notes: row.notes,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadWorkOrder(tx: TxHandle, id: string, lock = false): Promise<WorkOrderRow> {
  const result = await tx.client.query<WorkOrderRow>(`SELECT ${COLUMNS} FROM work_orders WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound("Repair");
  return row;
}

async function nextTicket(tx: TxHandle): Promise<number> {
  const result = await tx.client.query<{ ticket: number }>(
    `UPDATE ticket_counters SET next_value = next_value + 1 RETURNING next_value - 1 AS ticket`,
  );
  const ticket = result.rows[0]?.ticket;
  if (!ticket) throw new AppError("INTERNAL", "Ticket counter missing for this shop");
  if (ticket > 999_999) throw new AppError("INTERNAL", "Ticket numbers exhausted — widen the ticket format");
  return ticket;
}

async function event(
  tx: TxHandle,
  ctx: { tenantId: string; userId: string },
  input: { workOrderId: string; kind: string; from?: string | null; to?: string | null; note?: string | null; data?: Record<string, unknown> },
) {
  await tx.client.query(
    `INSERT INTO work_order_events (tenant_id, work_order_id, kind, from_status, to_status, note, data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ctx.tenantId,
      input.workOrderId,
      input.kind,
      input.from ?? null,
      input.to ?? null,
      input.note ?? null,
      JSON.stringify(input.data ?? {}),
      ctx.userId,
    ],
  );
}

export function registerWorkOrders(app: FastifyInstance, deps: Deps) {
  app.post(
    "/api/v2/work-orders/ticket-blocks",
    command(deps, { permission: "work_order.create", schema: ReserveTicketBlockCommand }, async ({ auth, tx }, body) => {
      const tenant = await loadTenant(tx);
      const register = await tx.client.query<{ store_id: string }>(`SELECT store_id FROM registers WHERE id = $1`, [body.registerId]);
      if (!register.rows[0]) throw notFound("Register");
      requireStoreAccess(auth, register.rows[0].store_id);
      const counter = await tx.client.query<{ next_value: number }>(`SELECT next_value FROM ticket_counters FOR UPDATE`);
      const { block, counterNext } = planBlock(counter.rows[0]!.next_value, body.size ?? tenant.ticketBlockSize);
      await tx.client.query(`UPDATE ticket_counters SET next_value = $1`, [counterNext]);
      const id = randomUUID();
      await tx.client.query(
        `INSERT INTO ticket_blocks (id, tenant_id, register_id, start_value, end_value, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, auth.tenantId, body.registerId, block.start, block.end, auth.userId],
      );
      return {
        status: 201,
        body: { id, registerId: body.registerId, start: block.start, end: block.end },
        audit: { action: "work_order.reserve_block", entityType: "ticket_block", entityId: id, data: { start: block.start, end: block.end } },
      };
    }),
  );

  app.post(
    "/api/v2/work-orders",
    command(deps, { permission: "work_order.create", schema: CreateWorkOrderCommand }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.storeId);
      const [tenant] = await Promise.all([loadTenant(tx), loadStore(tx, body.storeId)]);
      const ctx = { tenantId: auth.tenantId, userId: auth.userId };

      let ticket: number;
      if (body.reservedTicket !== undefined) {
        if (!body.registerId) throw new AppError("VALIDATION_FAILED", "A reserved ticket needs the register that reserved it");
        const owned = await tx.client.query(
          `SELECT 1 FROM ticket_blocks WHERE register_id = $1 AND $2 BETWEEN start_value AND end_value`,
          [body.registerId, body.reservedTicket],
        );
        if (!owned.rowCount) throw new AppError("VALIDATION_FAILED", "That ticket number was not reserved by this register");
        const used = await tx.client.query(`SELECT 1 FROM work_orders WHERE ticket_number = $1`, [body.reservedTicket]);
        if (used.rowCount) throw new AppError("CONFLICT", "That reserved ticket number was already used");
        ticket = body.reservedTicket;
      } else {
        ticket = await nextTicket(tx);
      }

      let customerId = body.customerId ?? null;
      let phone: string | null = null;
      let name = body.customerName ?? null;
      if (body.customerPhone) {
        const customer = await upsertCustomer(tx, { ...ctx, defaultCreditLimitCents: tenant.defaultCreditLimitCents }, {
          phone: body.customerPhone,
          name: body.customerName ?? null,
        });
        customerId = customer.id;
        phone = customer.phone;
        name = customer.name;
      } else if (customerId) {
        const c = await tx.client.query<{ phone: string; name: string | null }>(`SELECT phone, name FROM customers WHERE id = $1`, [
          customerId,
        ]);
        if (!c.rows[0]) throw notFound("Customer");
        phone = c.rows[0].phone;
        name = name ?? c.rows[0].name;
      }

      let imei: string | null = null;
      if (body.imei) {
        try {
          imei = normalizeImei(body.imei);
        } catch {
          throw new AppError("VALIDATION_FAILED", "That IMEI does not look right");
        }
      }

      const id = randomUUID();
      const enc = (value: string | undefined, field: string) =>
        value ? deps.cipher.encrypt(value, { tenantId: auth.tenantId, field }) : null;
      await tx.client.query(
        `INSERT INTO work_orders (id, tenant_id, store_id, ticket_number, customer_id, customer_phone, customer_name, model, imei, issue,
                                  fixes, estimate_cents, notify_by, expected_ready_date, device_passcode_enc, account_pin_enc,
                                  had_sim, had_sd_card, loaner_given, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          id,
          auth.tenantId,
          body.storeId,
          ticket,
          customerId,
          phone,
          name,
          body.model,
          imei,
          body.issue,
          JSON.stringify(body.fixes),
          body.estimateCents ?? null,
          body.notifyBy,
          body.expectedReadyDate ?? null,
          enc(body.devicePasscode, "device_passcode"),
          enc(body.accountPin, "account_pin"),
          body.hadSim,
          body.hadSdCard,
          body.loanerGiven,
          body.notes ?? null,
          auth.userId,
        ],
      );
      await event(tx, ctx, { workOrderId: id, kind: "created", to: "received" });
      if (phone) {
        await queueCustomerMessage(tx, auth.tenantId, {
          dedupeKey: `wo:${id}:received`,
          template: "repair_received",
          to: phone,
          vars: {
            company: tenant.name,
            model: body.model,
            ticket: String(ticket),
            issue: `Issue: ${body.issue}.`,
            expectedReady: body.expectedReadyDate ? `Estimated ready: ${body.expectedReadyDate}.` : "",
            paymentLine: "Payment: not paid yet.",
          },
        });
      }
      const row = await loadWorkOrder(tx, id);
      return {
        status: 201,
        body: toWorkOrderDto(row),
        audit: { action: "work_order.create", entityType: "work_order", entityId: id, storeId: body.storeId, data: { ticket } },
      };
    }),
  );

  app.get(
    "/api/v2/work-orders",
    query<Record<string, string>, { status?: string; storeId?: string; q?: string; cursor?: string; limit?: string }>(
      deps,
      "work_order.read",
      async ({ auth, tx, query: q }) => {
        const params: unknown[] = [];
        const where: string[] = [];
        const storeId = effective(auth).storeId ?? q.storeId;
        if (storeId) {
          params.push(storeId);
          where.push(`store_id = $${params.length}`);
        }
        if (!q.status || q.status === "open") {
          where.push(`status IN ('received','diagnosing','waiting_for_parts','in_repair','ready')`);
        } else if (q.status !== "all") {
          params.push(q.status);
          where.push(`status = $${params.length}`);
        }
        if (q.q) {
          const digits = q.q.replace(/\D/g, "");
          if (digits.length === 6) {
            params.push(Number(digits));
            where.push(`(ticket_number = $${params.length} OR id IN (SELECT work_order_id FROM work_order_ticket_aliases WHERE alias = $${params.length}::text))`);
          } else if (digits.length >= 4) {
            params.push(`%${digits}`);
            where.push(`regexp_replace(coalesce(customer_phone,''), '\\D', '', 'g') LIKE $${params.length}`);
          } else {
            params.push(`%${q.q}%`);
            where.push(`(customer_name ILIKE $${params.length} OR model ILIKE $${params.length})`);
          }
        }
        const cursor = decodeCursor(q.cursor);
        if (cursor) {
          params.push(cursor.createdAt, cursor.id);
          where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        const limit = pageLimit(q.limit);
        params.push(limit + 1);
        const rows = await tx.client.query<WorkOrderRow>(
          `SELECT ${COLUMNS} FROM work_orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
          params,
        );
        return toPage(rows.rows, limit, toWorkOrderDto);
      },
    ),
  );

  app.get(
    "/api/v2/work-orders/:id",
    query<{ id: string }>(deps, "work_order.read", async ({ auth, tx, params }) => {
      const row = await loadWorkOrder(tx, params.id);
      requireStoreAccess(auth, row.store_id);
      const events = await tx.client.query(
        `SELECT kind, from_status, to_status, note, created_at FROM work_order_events WHERE work_order_id = $1 ORDER BY created_at`,
        [row.id],
      );
      return { ...toWorkOrderDto(row), events: events.rows };
    }),
  );

  // Printing decrypts the passcode, so it is permission-checked and audited.
  app.get(
    "/api/v2/work-orders/:id/print",
    query<{ id: string }>(deps, "work_order.read", async ({ auth, tx, params, requestId, ip }) => {
      const row = await loadWorkOrder(tx, params.id);
      requireStoreAccess(auth, row.store_id);
      const [tenant, store] = await Promise.all([loadTenant(tx), loadStore(tx, row.store_id)]);
      const passcode = row.device_passcode_enc
        ? deps.cipher.decrypt(row.device_passcode_enc, { tenantId: auth.tenantId, field: "device_passcode" })
        : null;
      if (passcode) {
        await writeAudit(tx, auth, requestId, ip, {
          action: "work_order.reveal_passcode",
          entityType: "work_order",
          entityId: row.id,
          storeId: row.store_id,
        });
      }
      return {
        workOrder: toWorkOrderDto(row),
        devicePasscode: passcode,
        store: { name: store.name, address: store.address, phone: store.phone, hours: store.hours, timeZone: store.timeZone },
        company: { name: tenant.name, phone: tenant.company.phone, web: tenant.company.web, currency: tenant.currency },
        receiptNote: tenant.receiptNotes.repair ?? null,
      };
    }),
  );

  app.post(
    "/api/v2/work-orders/:id/status",
    command<typeof UpdateWorkOrderStatusCommand, { id: string }>(
      deps,
      { permission: "work_order.update", schema: UpdateWorkOrderStatusCommand },
      async ({ auth, tx, params, deps: d }, body) => {
        const tenant = await loadTenant(tx);
        const row = await loadWorkOrder(tx, params.id, true);
        requireStoreAccess(auth, row.store_id);
        if (row.version !== body.expectedVersion) {
          throw new AppError("VERSION_MISMATCH", "Someone else changed this repair — reload and try again", {
            currentVersion: row.version,
          });
        }
        const allowReopen = roleHas(effective(auth).role, "work_order.reopen");
        if (!canTransition(row.status, body.status, { allowReopen })) {
          throw new AppError("INVALID_TRANSITION", `A repair that is ${row.status} cannot become ${body.status}`);
        }
        const ctx = { tenantId: auth.tenantId, userId: auth.userId };
        const finalPrice = body.finalPriceCents ?? row.final_price_cents;
        let readyNotifyAt: Date | null = null;

        if (row.status === "ready" && body.status !== "ready") await cancelPending(tx, `wo:${row.id}:ready:`);

        if (body.status === "ready") {
          const plan = readyNotificationPlan(d.now(), body.notifyAt ? new Date(body.notifyAt) : null);
          readyNotifyAt = plan.scheduled ? plan.sendAt : null;
          if (row.customer_phone) {
            const total = repairTotals({ finalPriceCents: finalPrice, estimateCents: row.estimate_cents, fixes: row.fixes }).totalCents;
            const due = total - row.paid_cents;
            await queueCustomerMessage(tx, auth.tenantId, {
              dedupeKey: `wo:${row.id}:ready:${row.version + 1}`,
              template: "repair_ready",
              to: row.customer_phone,
              channel: row.notify_by,
              sendAt: plan.sendAt,
              vars: {
                company: tenant.name,
                model: row.model,
                ticket: String(row.ticket_number),
                amountDueLine: due > 0 ? `Amount due: ${formatMoney(due, tenant.currency)}.` : "",
              },
            });
          }
        }

        const clear = shouldClearSecrets(body.status);
        await tx.client.query(
          `UPDATE work_orders SET status = $2, final_price_cents = $3, ready_notify_at = $4,
                  device_passcode_enc = CASE WHEN $5 THEN NULL ELSE device_passcode_enc END,
                  account_pin_enc = CASE WHEN $5 THEN NULL ELSE account_pin_enc END,
                  picked_up_at = CASE WHEN $2 = 'picked_up' THEN now() ELSE picked_up_at END,
                  version = version + 1
            WHERE id = $1`,
          [row.id, body.status, finalPrice, readyNotifyAt, clear],
        );
        await event(tx, ctx, {
          workOrderId: row.id,
          kind: isOpenStatus(row.status) || body.status !== row.status ? "status" : "reopen",
          from: row.status,
          to: body.status,
          note: body.note ?? null,
          data: { ...(readyNotifyAt ? { readyNotifyAt: readyNotifyAt.toISOString() } : {}), secretsCleared: clear },
        });
        const updated = await loadWorkOrder(tx, row.id);
        return {
          status: 200,
          body: toWorkOrderDto(updated),
          audit: {
            action: "work_order.status",
            entityType: "work_order",
            entityId: row.id,
            storeId: row.store_id,
            data: { from: row.status, to: body.status, scheduled: Boolean(readyNotifyAt) },
          },
        };
      },
    ),
  );

  /** Lookup for the IVR and the counter: ticket (incl. legacy aliases) or phone. */
  app.get(
    "/api/v2/work-orders/lookup",
    query<Record<string, string>, { ticket?: string; phone?: string }>(deps, "work_order.read", async ({ tx, query: q }) => {
      if (q.ticket) {
        const ticket = parseTicketInput(q.ticket);
        if (!ticket) return { items: [] };
        const rows = await tx.client.query<WorkOrderRow>(
          `SELECT ${COLUMNS} FROM work_orders WHERE ticket_number = $1
           UNION SELECT ${COLUMNS} FROM work_orders WHERE id IN (SELECT work_order_id FROM work_order_ticket_aliases WHERE alias = $2)`,
          [ticket, String(ticket)],
        );
        return { items: rows.rows.map(toWorkOrderDto) };
      }
      const phone = q.phone ? normalizeUsPhone(q.phone) : null;
      if (!phone) return { items: [] };
      const rows = await tx.client.query<WorkOrderRow>(
        `SELECT ${COLUMNS} FROM work_orders WHERE customer_phone = $1 ORDER BY
           CASE WHEN status IN ('received','diagnosing','waiting_for_parts','in_repair','ready') THEN 0 ELSE 1 END, created_at DESC LIMIT 10`,
        [phone],
      );
      return { items: rows.rows.map(toWorkOrderDto) };
    }),
  );
}
