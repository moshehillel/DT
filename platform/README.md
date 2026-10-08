# POS platform (rewrite)

A multi-tenant point-of-sale, repair and rental platform. Diamant Telecom is
tenant #1; every shop-specific value (stores, tax rates, message texts, rental
prices, receipt notes, provider credentials) is tenant data, not code.

This directory is a separate workspace. **It does not change or deploy the live
app** (`../src`, `../functions`, Firebase project `diamant-telecom`). Nothing here
is wired to production.

## Layout

| Path | What it is |
| --- | --- |
| `packages/domain` | Pure business rules: money in integer cents, tax (ppm), tenders, rentals, tickets, stock, repair states, receipts, permissions. No I/O. |
| `packages/contracts` | Zod schemas for every API request/response, shared by API and web. |
| `packages/db` | Drizzle schema, SQL migrations, row-level security, `withTenant()` transactions, seed, test Postgres. |
| `packages/adapters` | Cardknox/Sola, Telebroad SMS, Twilio voice, RCUK, secrets; each with a fake for tests. |
| `apps/api` | Fastify HTTP API under `/api/v2`. |
| `apps/worker` | Outbox processor (texts, calls, card refunds, RCUK) and scheduled jobs. |
| `apps/web` | React 19 + Vite + TanStack Query register app (PWA-ready, offline queue). |
| `tools/migrate-firestore` | Dry-run transform of a Firestore export into the new model, with a reconciliation report. |

## How it is built

**Tenancy.** Every business table has `tenant_id`, `created_at`, `created_by` and
`version`. Postgres row-level security filters every row by
`current_setting('app.tenant_id')`. The API never connects as the table owner:
each request runs in one transaction that does `SET LOCAL ROLE app_user` and sets
the tenant, so a missing `WHERE tenant_id = …` cannot leak data. Cross-tenant
lookups (sign-in, webhook routing, the worker's claim) go through a handful of
`SECURITY DEFINER` functions. Ledgers (stock movements, customer ledger, audit
log, repair events, tax lines) are append-only for the app role.

**Commands.** Every write endpoint: authenticate (Firebase ID token) → permission
check for the effective role → Zod validation → required `Idempotency-Key` → one
transaction (advisory lock on the key, replay if already applied, the change,
an audit row, outbox rows, the stored response). A retried request returns the
original response with `idempotent-replayed: true`; reusing a key for a
different body is refused. Errors are typed (`{error:{code,message,requestId}}`);
nothing internal reaches the browser.

**Concurrency.** Stock balances are row-locked before a movement is applied, so
two stores (or two registers) selling at once keep exact counts and the last
unit cannot be sold twice. Refund and return caps are single conditional
`UPDATE`s backed by `CHECK` constraints, so concurrent refunds cannot exceed the
payment. Repairs use optimistic `expectedVersion`.

**Card payments.** A card tender creates a payment with a fixed
`externalRequestId` *before* the terminal is called. Confirm is three steps:
lock and mark `processing` (commit) → call the terminal outside any transaction
→ record `captured` / `declined` / `pending_verification`. An unknown outcome is
never retried as a new charge; it is looked up by `externalRequestId`, from the
register ("Verify") or by the worker's reconciliation job.

**Side effects.** Texts, calls, card refunds and RCUK requests are written to an
outbox in the same transaction as the business change, one row per business
event (dedupe key). The worker claims rows with `FOR UPDATE SKIP LOCKED` and a
lease, records "sending" before calling a provider, retries definite failures
with exponential backoff, and parks anything that *might* have been delivered
(`needs_review`) instead of sending it twice. Scheduled "ready" texts are outbox
rows with a future `available_at`, cancelled if the repair leaves "ready".

**Sensitive data.** Device passcodes and account PINs are AES-256-GCM encrypted
per field with key ids (rotation-ready; `EnvKeyProvider` is the KMS seam),
decrypted only for printing (audited) and cleared when a repair is picked up or
cancelled. Till PINs are scrypt hashes; a PIN switch issues a short-lived
operator token bound to the device that unlocked it.

## Run it locally

Requirements: Node 22+, pnpm 9 (`corepack enable` or `npm i -g pnpm` as your
user). Docker is optional.

```sh
cd platform
pnpm install
pnpm typecheck && pnpm test      # tests start a real Postgres 17 themselves (embedded-postgres); no Docker needed
```

To run the apps you need a Postgres (Docker: `pnpm db:up`, or any Postgres 15+):

```sh
# 1. migrate + seed as the database owner
set DATABASE_URL=postgres://postgres:postgres@localhost:5432/pos
pnpm db:migrate
set SEED_OWNER_FIREBASE_UID=<your firebase uid or a dev uid>
pnpm db:seed

# 2. a login for the apps that is NOT the owner
psql "%DATABASE_URL%" -c "CREATE ROLE pos_app LOGIN PASSWORD 'devpass' IN ROLE app_user"

# 3. configure and start (copy each .env.example to .env and fill in)
pnpm dev:api      # http://localhost:8080  (apps/api/.env)
pnpm dev:worker   # apps/worker/.env
pnpm dev:web      # http://localhost:5173  (apps/web/.env, proxies /api)
```

With `AUTH_MODE=dev` the API accepts HS256 tokens signed with `DEV_AUTH_SECRET`
(refused when `NODE_ENV=production`), so you can work without Firebase.

## Cutover plan (strangler, no big bang)

1. **Shadow.** Deploy API + worker + Postgres next to the live app. Nothing
   points at them. Run the Firestore migration dry run nightly and read the
   reconciliation report until it is clean.
2. **Read-only pilot.** One register at one store opens the new web app against
   `/api/v2` with migrated data, for look-ups only.
3. **One store live.** That store rings sales, repairs and stock on the new app.
   A one-way sync job copies its new records back into Firestore so the old
   reports/screens stay complete for the other stores. Old app keeps running
   everywhere else.
4. **Store by store.** Move the remaining stores. Each move: final migration of
   that store's open repairs, stock count, cash count, then switch.
5. **Integrations last.** Repoint Telebroad/Twilio/Shopify webhooks to
   `/api/v2/webhooks/<tenant>/…` once every store is on the new app; then
   retire the Cloud Functions.
6. **Freeze.** Firestore becomes read-only history; keep the export.

Rollback at any step is "point that register back at the old app": the old app
is untouched and keeps running until step 6.

## Data migration (`tools/migrate-firestore`)

```sh
pnpm --filter @pos/migrate-firestore plan -- input/export.json [input/stores.json]
```

Reads a JSON export (`customers`, `products`, `reports`, `stores`), writes
`output/plan.json` and `output/report.md`, exits non-zero if there are errors or
the money does not balance. `input/` and `output/` are git-ignored (customer
data). It currently plans; the loader that inserts the plan through `withTenant`
is not written yet.

- Money: floats and strings (`"$1,234.50"`, `12.5`) become integer cents.
- Stores: old free-text names map to store codes (`stores.json`).
- Customers: deduplicated by normalised US phone; every source balance becomes
  its own opening ledger entry, and the report proves source total = ledger total.
- Repairs: 6-digit tickets are kept; clashes and legacy formats are renumbered
  after the highest ticket, and every old number is kept as an alias so the IVR
  and counter search still find them.

## Decisions needed from the owner

1. **Postgres hosting.** Cloud SQL for PostgreSQL (same Google account as
   Firebase), Neon, or Supabase. Needs: Postgres 15+, point-in-time recovery,
   a non-owner login for the apps.
2. **Where the API and worker run.** Cloud Run (two services) is the natural fit.
3. **Secrets.** Move Sola/Cardknox, Telebroad, Twilio, RCUK and Shopify secrets
   into Secret Manager, one set per tenant (`TENANT_<SLUG>__<NAME>`), plus the
   field-encryption key (ideally a KMS key).
4. **Tax.** Confirm with the accountant: rates per store (8.875% Brooklyn,
   8.125% upstate, 8% — all flagged `taxRateNeedsConfirmation`), whether repair
   labour is taxable, and whether the old "cash portion exempt" split
   (`legacy_split_cash_exempt` mode) was ever correct. The default is per-item
   tax on the full sale.
5. **Deposit refunds and Shopify/Telebroad processing** are parked for a
   manager in this version (see "What is stubbed").

## What is stubbed

- Rental deposit refunds: queued, then parked for a manager (`needs_review`).
- Shopify orders and Telebroad call events: verified, stored once, not yet
  turned into POS records.
- Firestore loader (plan → database) and the step-3 back-sync to Firestore.
- Email (SMTP) adapter interface + fake exist; no real sender is wired.
