import { DEFAULT_TAX_RULES, DIAMANT_RENTAL_PRICE_BOOK, type RentalPriceBook, type TaxRuleSet } from "@pos/domain";
import type { TxHandle } from "@pos/db";
import { notFound } from "../lib/errors.js";

export interface TenantSettings {
  slug: string;
  name: string;
  company: { phone: string; web: string; email: string };
  currency: string;
  allowNegativeStock: boolean;
  defaultCreditLimitCents: number;
  ticketBlockSize: number;
  receiptNotes: Record<string, string>;
  rentalPriceBook: RentalPriceBook;
}

export async function loadTenant(tx: TxHandle): Promise<TenantSettings> {
  const result = await tx.client.query<{ slug: string; name: string; settings: Record<string, unknown> }>(
    `SELECT slug, name, settings FROM tenants LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) throw notFound("Tenant");
  const s = row.settings ?? {};
  return {
    slug: row.slug,
    name: row.name,
    company: (s.company as TenantSettings["company"]) ?? { phone: "", web: "", email: "" },
    currency: (s.currency as string) ?? "USD",
    allowNegativeStock: Boolean(s.allowNegativeStock),
    defaultCreditLimitCents: Number(s.defaultCreditLimitCents ?? 0),
    ticketBlockSize: Number(s.ticketBlockSize ?? 25),
    receiptNotes: (s.receiptNotes as Record<string, string>) ?? {},
    rentalPriceBook: (s.rentalPriceBook as RentalPriceBook) ?? DIAMANT_RENTAL_PRICE_BOOK,
  };
}

export interface StoreRow {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  hours: string;
  timeZone: string;
  taxRules: TaxRuleSet;
}

export async function loadStore(tx: TxHandle, storeId: string): Promise<StoreRow> {
  const result = await tx.client.query<{
    id: string;
    code: string;
    name: string;
    address: string;
    phone: string;
    hours: string;
    time_zone: string;
    tax_rules: TaxRuleSet;
  }>(`SELECT id, code, name, address, phone, hours, time_zone, tax_rules FROM stores WHERE id = $1 AND active`, [storeId]);
  const row = result.rows[0];
  if (!row) throw notFound("Store");
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    phone: row.phone,
    hours: row.hours,
    timeZone: row.time_zone,
    taxRules: { ...DEFAULT_TAX_RULES, ...row.tax_rules },
  };
}
