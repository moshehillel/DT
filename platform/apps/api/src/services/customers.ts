import { normalizeUsPhone, titleCaseName } from "@pos/domain";
import type { TxHandle } from "@pos/db";
import { AppError, notFound } from "../lib/errors.js";

export interface CustomerRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  address: string | null;
  mobile: string | null;
  credit_limit_cents: number;
  version: number;
  balance_cents: number;
}

export function toCustomerDto(row: CustomerRow) {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    address: row.address,
    balanceCents: Number(row.balance_cents),
    creditLimitCents: row.credit_limit_cents,
    version: row.version,
  };
}

const SELECT_CUSTOMER = `
  SELECT c.id, c.phone, c.name, c.email, c.address, c.mobile, c.credit_limit_cents, c.version,
         coalesce((SELECT sum(amount_cents) FROM customer_ledger_entries l WHERE l.customer_id = c.id), 0)::int AS balance_cents
    FROM customers c`;

export function requirePhone(raw: string): string {
  const phone = normalizeUsPhone(raw);
  if (!phone) throw new AppError("VALIDATION_FAILED", "Enter a complete 10-digit phone number");
  return phone;
}

/**
 * Race-free upsert keyed on (tenant, phone): two registers adding the same
 * customer at once converge on one row. Blank fields never erase stored ones.
 */
export async function upsertCustomer(
  tx: TxHandle,
  ctx: { tenantId: string; userId: string; defaultCreditLimitCents: number },
  input: { phone: string; name?: string | null; email?: string | null; address?: string | null; mobile?: string | null },
): Promise<CustomerRow> {
  const phone = requirePhone(input.phone);
  const name = input.name ? titleCaseName(input.name) : null;
  const mobile = input.mobile ? normalizeUsPhone(input.mobile) : null;
  const result = await tx.client.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone, name, email, address, mobile, credit_limit_cents, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET
       name = coalesce(EXCLUDED.name, customers.name),
       email = coalesce(EXCLUDED.email, customers.email),
       address = coalesce(EXCLUDED.address, customers.address),
       mobile = coalesce(EXCLUDED.mobile, customers.mobile),
       version = customers.version + CASE WHEN
         (EXCLUDED.name IS NOT NULL AND EXCLUDED.name IS DISTINCT FROM customers.name) OR
         (EXCLUDED.email IS NOT NULL AND EXCLUDED.email IS DISTINCT FROM customers.email) OR
         (EXCLUDED.address IS NOT NULL AND EXCLUDED.address IS DISTINCT FROM customers.address) OR
         (EXCLUDED.mobile IS NOT NULL AND EXCLUDED.mobile IS DISTINCT FROM customers.mobile)
         THEN 1 ELSE 0 END
     RETURNING id`,
    [
      ctx.tenantId,
      phone,
      name,
      input.email ?? null,
      input.address ?? null,
      mobile,
      ctx.defaultCreditLimitCents,
      ctx.userId,
    ],
  );
  return getCustomer(tx, result.rows[0]!.id);
}

export async function getCustomer(tx: TxHandle, id: string, opts: { lock?: boolean } = {}): Promise<CustomerRow> {
  if (opts.lock) await tx.client.query(`SELECT 1 FROM customers WHERE id = $1 FOR UPDATE`, [id]);
  const result = await tx.client.query<CustomerRow>(`${SELECT_CUSTOMER} WHERE c.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound("Customer");
  return row;
}

export async function searchCustomers(tx: TxHandle, q: string, limit: number, cursor: { createdAt: string; id: string } | null) {
  const digits = q.replace(/\D/g, "");
  const params: unknown[] = [];
  const where: string[] = ["c.merged_into_id IS NULL"];
  if (digits.length >= 3) {
    params.push(`%${digits}%`);
    where.push(`regexp_replace(c.phone, '\\D', '', 'g') LIKE $${params.length}`);
  } else if (q.trim()) {
    params.push(`%${q.trim()}%`);
    where.push(`c.name ILIKE $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where.push(`(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  return tx.client.query<CustomerRow & { created_at: Date }>(
    `SELECT c.id, c.phone, c.name, c.email, c.address, c.mobile, c.credit_limit_cents, c.version, c.created_at,
            coalesce((SELECT sum(amount_cents) FROM customer_ledger_entries l WHERE l.customer_id = c.id), 0)::int AS balance_cents
       FROM customers c WHERE ${where.join(" AND ")}
      ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length}`,
    params,
  );
}

export async function addLedgerEntry(
  tx: TxHandle,
  ctx: { tenantId: string; userId: string },
  entry: { customerId: string; amountCents: number; kind: string; reason?: string | null; orderId?: string | null },
): Promise<void> {
  await tx.client.query(
    `INSERT INTO customer_ledger_entries (tenant_id, customer_id, amount_cents, kind, reason, order_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.tenantId, entry.customerId, entry.amountCents, entry.kind, entry.reason ?? null, entry.orderId ?? null, ctx.userId],
  );
}
