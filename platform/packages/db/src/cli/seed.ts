import { DIAMANT_TENANT_SEED } from "@pos/domain";
import { createPool, seedTenant } from "../index.js";

/**
 * Seeds Diamant Telecom as tenant #1 for local development. The owner's
 * Firebase UID must be supplied — there is no default account.
 */
const url = process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL;
const uid = process.env.SEED_OWNER_FIREBASE_UID;
const email = process.env.SEED_OWNER_EMAIL ?? "";
if (!url || !uid) {
  console.error("Set DATABASE_OWNER_URL and SEED_OWNER_FIREBASE_UID (and optionally SEED_OWNER_EMAIL, SEED_OWNER_NAME).");
  process.exit(1);
}
const pool = createPool(url, 1);
const result = await seedTenant(pool, DIAMANT_TENANT_SEED, {
  firebaseUid: uid,
  email,
  displayName: process.env.SEED_OWNER_NAME ?? "Owner",
});
await pool.end();
console.log(JSON.stringify(result, null, 2));
