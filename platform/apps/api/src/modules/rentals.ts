import { randomUUID } from "node:crypto";
import { CreateRentalCommand, ReturnRentalCommand, Tender } from "@pos/contracts";
import { addDays, normalizeRcukSimNumber, quoteRental, rentalLateFee, returnDueDate, zonedTimeToUtc } from "@pos/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStoreAccess } from "../lib/auth.js";
import { command, query } from "../lib/command.js";
import type { Deps } from "../lib/deps.js";
import { AppError, notFound } from "../lib/errors.js";
import { cancelPending, enqueue } from "../lib/outbox.js";
import { decodeCursor, pageLimit, toPage } from "../lib/pagination.js";
import { getCustomer } from "../services/customers.js";
import { queueCustomerMessage } from "../services/notifications.js";
import { createSaleOrder, loadOrder } from "../services/orders.js";
import { loadStore, loadTenant } from "../services/tenant.js";

const CreateRentalWithTenders = CreateRentalCommand.extend({
  tenders: z.array(Tender).max(4),
  collectLater: z.object({ dueDate: z.string() }).optional(),
});

export function registerRentals(app: FastifyInstance, deps: Deps) {
  app.get(
    "/api/v2/rentals/price-book",
    query<Record<string, string>, Record<string, string>>(deps, "rental.read", async ({ tx }) => {
      const tenant = await loadTenant(tx);
      return { priceBook: tenant.rentalPriceBook };
    }),
  );

  app.post(
    "/api/v2/rentals",
    command(deps, { permission: "rental.create", schema: CreateRentalWithTenders }, async ({ auth, tx }, body) => {
      requireStoreAccess(auth, body.storeId);
      const [tenant, store] = await Promise.all([loadTenant(tx), loadStore(tx, body.storeId)]);
      const customer = await getCustomer(tx, body.customerId);
      const quote = quoteRental(tenant.rentalPriceBook, body);
      if (quote.totalDays <= 0) throw new AppError("VALIDATION_FAILED", "The end date is before the start date");
      if (!quote.meetsMinimum) {
        throw new AppError("VALIDATION_FAILED", `${body.region} rentals are at least ${quote.minimumDays} days`);
      }
      if (body.deviceKind !== "sim_only" && !body.serializedUnitId) {
        throw new AppError("VALIDATION_FAILED", "Pick the rental handset");
      }
      if (body.serializedUnitId) {
        const unit = await tx.client.query(`SELECT 1 FROM serialized_units WHERE id = $1 AND status = 'rental_fleet' FOR UPDATE`, [
          body.serializedUnitId,
        ]);
        if (!unit.rowCount) throw new AppError("UNIT_NOT_AVAILABLE", "That handset is not in the rental fleet");
        const busy = await tx.client.query(
          `SELECT 1 FROM rental_contracts WHERE serialized_unit_id = $1 AND status = 'active'`,
          [body.serializedUnitId],
        );
        if (busy.rowCount) throw new AppError("UNIT_NOT_AVAILABLE", "That handset is already out on another rental");
      }
      const deposit = body.depositCents ?? (body.deviceKind === "sim_only" ? tenant.rentalPriceBook.simOnlyDepositCents : 0);
      const rentalId = randomUUID();
      const dueDate = returnDueDate(body.endDate, body.graceDays);
      const simNumber = normalizeRcukSimNumber(body.simNumber);

      await tx.client.query(
        `INSERT INTO rental_contracts (id, tenant_id, store_id, customer_id, region, service_type, add_sms, device_kind, serialized_unit_id,
                                       sim_number, start_date, end_date, return_due_date, total_cents, late_fee_weekly_cents, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          rentalId,
          auth.tenantId,
          store.id,
          customer.id,
          body.region,
          body.serviceType,
          body.addSms,
          body.deviceKind,
          body.serializedUnitId ?? null,
          simNumber,
          body.startDate,
          body.endDate,
          dueDate,
          quote.totalCents,
          body.lateFeeWeeklyCents,
          auth.userId,
        ],
      );
      const lines = [
        {
          kind: "rental" as const,
          description: `Rental ${body.region} ${body.startDate}..${body.endDate} (${quote.totalDays} days)`,
          qty: 1,
          unitPriceCents: quote.totalCents,
          taxCategory: "rental",
          rentalContractId: rentalId,
        },
        ...(deposit > 0
          ? [{ kind: "deposit" as const, description: "Refundable deposit", qty: 1, unitPriceCents: deposit, taxCategory: "deposit", rentalContractId: rentalId }]
          : []),
      ];
      const { orderId, pendingPaymentIds } = await createSaleOrder(
        tx,
        { tenantId: auth.tenantId, userId: auth.userId },
        { store, tenant, customerId: customer.id, lines, tenders: body.tenders, collectLater: body.collectLater ?? null, registerId: auth.registerId },
      );
      await tx.client.query(`UPDATE rental_contracts SET order_id = $2 WHERE id = $1`, [rentalId, orderId]);
      await tx.client.query(`INSERT INTO rental_lines (tenant_id, rental_id, kind, amount_cents) VALUES ($1,$2,'rental',$3)`, [
        auth.tenantId,
        rentalId,
        quote.totalCents,
      ]);
      if (deposit > 0) {
        await tx.client.query(`INSERT INTO rental_deposits (tenant_id, rental_id, amount_cents) VALUES ($1,$2,$3)`, [
          auth.tenantId,
          rentalId,
          deposit,
        ]);
      }
      await enqueue(tx, auth.tenantId, {
        topic: "rental.rcuk_add",
        dedupeKey: `rental:${rentalId}:rcuk_add`,
        payload: { rentalId },
      });
      await queueCustomerMessage(tx, auth.tenantId, {
        dedupeKey: `rental:${rentalId}:return_reminder`,
        template: "rental_return_reminder",
        to: customer.phone,
        vars: { company: tenant.name, returnDate: dueDate, companyPhone: tenant.company.phone },
        sendAt: zonedTimeToUtc(addDays(dueDate, -1), 10, 0, store.timeZone),
      });
      const order = await loadOrder(tx, orderId);
      return {
        status: 201,
        body: {
          rental: { id: rentalId, returnDueDate: dueDate, totalCents: quote.totalCents, depositCents: deposit, totalDays: quote.totalDays },
          order,
          pendingPayments: order.payments.filter((p) => pendingPaymentIds.includes(p.id)),
        },
        audit: { action: "rental.create", entityType: "rental", entityId: rentalId, storeId: store.id, data: { totalCents: quote.totalCents, deposit } },
      };
    }),
  );

  app.post(
    "/api/v2/rentals/:id/return",
    command<typeof ReturnRentalCommand, { id: string }>(
      deps,
      { permission: "rental.return", schema: ReturnRentalCommand },
      async ({ auth, tx, params }, body) => {
        const rental = await tx.client.query<{
          id: string;
          store_id: string;
          status: string;
          version: number;
          return_due_date: string;
          late_fee_weekly_cents: number;
        }>(`SELECT id, store_id, status, version, return_due_date, late_fee_weekly_cents FROM rental_contracts WHERE id = $1 FOR UPDATE`, [
          params.id,
        ]);
        const row = rental.rows[0];
        if (!row) throw notFound("Rental");
        requireStoreAccess(auth, row.store_id);
        if (row.version !== body.expectedVersion) throw new AppError("VERSION_MISMATCH", "This rental changed — reload it");
        if (row.status !== "active") throw new AppError("INVALID_TRANSITION", `This rental is already ${row.status}`);
        const fee = body.waiveLateFee
          ? { daysLate: 0, amountCents: 0 }
          : rentalLateFee({ dueDate: row.return_due_date, asOf: body.returnedOn, weeklyFeeCents: row.late_fee_weekly_cents });
        await tx.client.query(
          `UPDATE rental_contracts SET status = 'returned', returned_on = $2, late_fee_cents = $3, version = version + 1 WHERE id = $1`,
          [row.id, body.returnedOn, fee.amountCents],
        );
        await cancelPending(tx, `rental:${row.id}:return_reminder`);
        const deposit = await tx.client.query<{ id: string }>(
          `UPDATE rental_deposits SET status = 'refund_due', version = version + 1 WHERE rental_id = $1 AND status = 'held' RETURNING id`,
          [row.id],
        );
        if (deposit.rows[0]) {
          await enqueue(tx, auth.tenantId, {
            topic: "rental.deposit_refund",
            dedupeKey: `rental:${row.id}:deposit_refund`,
            payload: { rentalId: row.id, depositId: deposit.rows[0].id },
          });
        }
        return {
          status: 200,
          body: { id: row.id, status: "returned", lateFeeCents: fee.amountCents, daysLate: fee.daysLate, depositRefundQueued: Boolean(deposit.rows[0]) },
          audit: { action: "rental.return", entityType: "rental", entityId: row.id, storeId: row.store_id, data: { ...fee, waived: body.waiveLateFee } },
        };
      },
    ),
  );

  app.get(
    "/api/v2/rentals",
    query<Record<string, string>, { status?: string; cursor?: string; limit?: string }>(deps, "rental.read", async ({ tx, query: q }) => {
      const params: unknown[] = [q.status ?? "active"];
      let where = "status = $1";
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where += ` AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
      }
      const limit = pageLimit(q.limit);
      params.push(limit + 1);
      const rows = await tx.client.query(
        `SELECT id, created_at, store_id, customer_id, region, device_kind, sim_number, start_date, end_date, return_due_date,
                total_cents, late_fee_weekly_cents, status, version FROM rental_contracts
          WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return toPage(rows.rows, limit, (r) => ({
        id: r.id,
        storeId: r.store_id,
        customerId: r.customer_id,
        region: r.region,
        deviceKind: r.device_kind,
        simNumber: r.sim_number,
        startDate: r.start_date,
        endDate: r.end_date,
        returnDueDate: r.return_due_date,
        totalCents: r.total_cents,
        lateFeeWeeklyCents: r.late_fee_weekly_cents,
        status: r.status,
        version: r.version,
        createdAt: r.created_at.toISOString(),
      }));
    }),
  );
}
