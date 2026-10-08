import { DEFAULT_TEMPLATES, type Role, type TenantSeed } from "@pos/domain";
import type pg from "pg";

export interface SeedOwner {
  firebaseUid: string;
  email: string;
  displayName: string;
  role?: Role;
}

export interface SeededTenant {
  tenantId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  stores: { id: string; code: string; registerId: string }[];
}

/**
 * Creates a tenant with its stores, one register per store, default
 * notification templates and the ticket counter. Provisioning a tenant is a
 * platform-operator action, so this runs as the owner role (outside RLS).
 */
export async function seedTenant(client: pg.Pool | pg.PoolClient, seed: TenantSeed, owner: SeedOwner): Promise<SeededTenant> {
  const q = <R extends pg.QueryResultRow>(text: string, values: unknown[] = []) => client.query<R>(text, values);

  const tenant = await q<{ id: string }>(
    `INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [
      seed.slug,
      seed.name,
      JSON.stringify({
        company: seed.company,
        currency: seed.currency,
        receiptNotes: seed.receiptNotes,
        rentalPriceBook: seed.rentalPriceBook,
        ...seed.settings,
      }),
    ],
  );
  const tenantId = tenant.rows[0]!.id;

  const stores: SeededTenant["stores"] = [];
  for (const store of seed.stores) {
    const row = await q<{ id: string }>(
      `INSERT INTO stores (tenant_id, code, name, address, phone, hours, time_zone, tax_rules, tax_rate_needs_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [
        tenantId,
        store.code,
        store.name,
        store.address,
        store.phone,
        store.hours,
        store.timeZone,
        JSON.stringify(store.taxRules),
        store.taxRateNeedsConfirmation,
      ],
    );
    const storeId = row.rows[0]!.id;
    const existing = await q<{ id: string }>(`SELECT id FROM registers WHERE store_id = $1 ORDER BY created_at LIMIT 1`, [
      storeId,
    ]);
    const registerId =
      existing.rows[0]?.id ??
      (
        await q<{ id: string }>(`INSERT INTO registers (tenant_id, store_id, name) VALUES ($1,$2,$3) RETURNING id`, [
          tenantId,
          storeId,
          `${store.name} register 1`,
        ])
      ).rows[0]!.id;
    stores.push({ id: storeId, code: store.code, registerId });
  }

  for (const [key, body] of Object.entries(DEFAULT_TEMPLATES)) {
    await q(
      `INSERT INTO notification_templates (tenant_id, key, channel, body) VALUES ($1,$2,'sms',$3)
       ON CONFLICT DO NOTHING`,
      [tenantId, key, body],
    );
  }
  await q(`INSERT INTO ticket_counters (tenant_id, next_value) VALUES ($1, 100001) ON CONFLICT DO NOTHING`, [tenantId]);

  const user = await q<{ id: string }>(
    `INSERT INTO users (firebase_uid, email, display_name) VALUES ($1,$2,$3)
     ON CONFLICT (firebase_uid) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [owner.firebaseUid, owner.email, owner.displayName],
  );
  const ownerUserId = user.rows[0]!.id;
  const membership = await q<{ id: string }>(
    `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
    [tenantId, ownerUserId, owner.role ?? "owner"],
  );

  return { tenantId, ownerUserId, ownerMembershipId: membership.rows[0]!.id, stores };
}
