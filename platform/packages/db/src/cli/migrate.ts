import { runMigrations } from "../index.js";

const url = process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_OWNER_URL (or DATABASE_URL) to the migration/owner connection string.");
  process.exit(1);
}
await runMigrations(url);
console.log("migrations applied");
