import fs from "node:fs";
import path from "node:path";
import { DIAMANT_TENANT_SEED, formatMoney } from "@pos/domain";
import { planMigration, reconcile, type FirestoreExport, type StoreMapping } from "./transform.js";

/**
 * Dry run only: reads a Firestore export JSON and writes the migration plan
 * plus a reconciliation report. It never connects to Firestore or Postgres.
 *
 *   pnpm --filter @pos/migrate-firestore plan -- input/export.json [input/stores.json]
 *
 * stores.json maps the old free-text store names to new store codes, e.g.
 *   { "Brooklyn": "BKN", "Upstate": "UPS" }
 * Without it, the seeded store names are used.
 */
const [inputPath, mappingPath] = process.argv.slice(2).filter((a) => a !== "--");
if (!inputPath) {
  console.error("usage: plan <export.json> [stores.json]");
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8")) as FirestoreExport;
const mapping: StoreMapping = mappingPath
  ? (JSON.parse(fs.readFileSync(mappingPath, "utf8")) as StoreMapping)
  : Object.fromEntries(DIAMANT_TENANT_SEED.stores.map((s) => [s.name, s.code]));

const plan = planMigration(data, mapping);
const report = reconcile(data, plan);

const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "output");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));

const lines = [
  "# Firestore migration dry run",
  "",
  `Customers: ${report.customers.sourceDocs} documents -> ${report.customers.migrated} customers (${report.customers.merged} merged, ${report.customers.rejected} rejected)`,
  `Balances: source ${formatMoney(report.customers.sourceBalanceCents)} vs ledger ${formatMoney(report.customers.ledgerCents)} -> ${report.customers.balanced ? "BALANCED" : "MISMATCH"}`,
  `Stock units: source ${report.stock.sourceUnits}, migrated ${report.stock.migratedUnits}, not migrated ${report.stock.unmigratedUnits}`,
  `Repairs: ${report.repairs.sourceDocs} -> ${report.repairs.migrated} (${report.repairs.renumbered} renumbered, ${report.repairs.aliases} aliases kept)`,
  `Next ticket number: ${plan.nextTicket}`,
  "",
  `## Issues (${report.errors} errors, ${report.warnings} warnings)`,
  "",
  ...plan.issues.map((i) => `- [${i.severity}] ${i.entity} ${i.sourceId}: ${i.message}`),
  "",
];
fs.writeFileSync(path.join(outDir, "report.md"), lines.join("\n"));
console.log(lines.slice(0, 8).join("\n"));
console.log(`\nWrote ${path.join(outDir, "plan.json")} and report.md`);
process.exit(report.errors > 0 || !report.customers.balanced ? 1 : 0);
