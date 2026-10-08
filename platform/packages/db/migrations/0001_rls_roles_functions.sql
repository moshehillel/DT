-- Row-level security, application role, append-only ledgers and the few
-- SECURITY DEFINER entry points that legitimately cross tenants.
--
-- The API and worker never query as the table owner. Every request runs in a
-- transaction that does `SET LOCAL ROLE app_user` and
-- `set_config('app.tenant_id', <uuid>, true)`, so a query that forgets a
-- tenant filter still only sees the current tenant's rows. With no tenant set,
-- every policy evaluates to false and nothing is visible.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'stores','memberships','registers','products','product_variants','inventory_balances',
    'serialized_units','stock_movements','customers','customer_ledger_entries','orders',
    'order_lines','tax_lines','payments','refunds','shifts','cash_movements','ticket_counters',
    'ticket_blocks','work_orders','work_order_ticket_aliases','work_order_events',
    'rental_contracts','rental_lines','rental_deposits','phone_orders','deliveries',
    'notification_templates','outbox','notification_attempts','audit_log','webhook_events',
    'idempotency_keys'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- Ledgers are append-only for the application.
REVOKE UPDATE, DELETE ON stock_movements, customer_ledger_entries, audit_log, work_order_events, tax_lines, notification_attempts FROM app_user;
--> statement-breakpoint
GRANT UPDATE (status, completed_at, provider_message_id, error) ON notification_attempts TO app_user;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_self ON tenants USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, UPDATE ON tenants TO app_user;
--> statement-breakpoint
-- Users are global identities; a tenant can see itself and its own members only.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_visible ON users
  USING (id = app_current_user() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));
--> statement-breakpoint
GRANT SELECT ON users TO app_user;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Cross-tenant entry points (SECURITY DEFINER, fixed search_path, narrow output)
-- ---------------------------------------------------------------------------

-- Resolve a verified identity to its memberships. Called before a tenant is
-- chosen, so it cannot run under tenant RLS.
CREATE OR REPLACE FUNCTION app_auth_lookup(p_firebase_uid text)
RETURNS TABLE (
  user_id uuid, display_name text, membership_id uuid, tenant_id uuid,
  tenant_name text, role text, store_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.display_name, m.id, m.tenant_id, t.name, m.role, m.store_id
  FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.active
  JOIN tenants t ON t.id = m.tenant_id
  WHERE u.firebase_uid = p_firebase_uid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_tenant_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id FROM tenants WHERE slug = p_slug $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id FROM tenants ORDER BY id $$;
--> statement-breakpoint
-- Worker: claim a batch of due outbox messages across tenants. Rows whose
-- lease expired (worker crashed mid-message) are reclaimed.
CREATE OR REPLACE FUNCTION app_claim_outbox(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, tenant_id uuid, topic text, payload jsonb, attempts integer, max_attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE outbox o
     SET status = 'processing',
         locked_until = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
   WHERE o.id IN (
     SELECT c.id FROM outbox c
      WHERE (c.status = 'pending' AND c.available_at <= now())
         OR (c.status = 'processing' AND c.locked_until < now())
      ORDER BY c.available_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING o.id, o.tenant_id, o.topic, o.payload, o.attempts, o.max_attempts
$$;
--> statement-breakpoint
-- Staff invites create (or reuse) the global identity row; the membership is
-- then inserted under tenant RLS by the caller.
CREATE OR REPLACE FUNCTION app_upsert_user(p_firebase_uid text, p_email text, p_display_name text) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO users (firebase_uid, email, display_name)
  VALUES (p_firebase_uid, p_email, p_display_name)
  ON CONFLICT (firebase_uid) DO UPDATE SET email = coalesce(EXCLUDED.email, users.email)
  RETURNING id
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_auth_lookup(text), app_tenant_by_slug(text), app_tenant_ids(), app_claim_outbox(integer, integer), app_upsert_user(text, text, text), app_current_tenant(), app_current_user() TO app_user;
