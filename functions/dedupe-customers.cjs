// Reports (and optionally merges) duplicate customer records that share a phone
// number. Read-only unless run with --apply.
const admin = require("firebase-admin");
const fs = require("fs");

const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: "diamant-telecom" });
const db = admin.firestore();
db.settings({ preferRest: true });

const score = (c) =>
  (c.name?.trim() ? 4 : 0) +
  (c.address?.trim() ? 2 : 0) +
  (c.email?.trim() ? 1 : 0) +
  (c.notes?.trim() ? 1 : 0) +
  (c.contactDetails?.trim() ? 1 : 0) +
  (c.mobile?.trim() ? 1 : 0);

// Prefer the loser's value only where the winner is blank.
const fill = (winner, loser, field) =>
  winner[field]?.trim() ? winner[field] : (loser[field]?.trim() || "");

(async () => {
  const snap = await db.collection("customers").get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`Total customer docs: ${all.length}`);

  const byPhone = new Map();
  for (const c of all) {
    const key = (c.phoneDigits || "").trim();
    if (!key) continue;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(c);
  }

  const groups = [...byPhone.entries()].filter(([, list]) => list.length > 1);
  const noPhone = all.filter((c) => !(c.phoneDigits || "").trim());

  console.log(`Phone numbers with more than one record: ${groups.length}`);
  console.log(`Records with no phoneDigits at all: ${noPhone.length}`);
  console.log("");

  // Snapshot every doc we are about to touch, so an --apply run is recoverable.
  if (APPLY && groups.length) {
    const backupPath = `customers-dedupe-backup-${Date.now()}.json`;
    const touched = groups.flatMap(([phone, list]) => list.map((c) => ({ phone, ...c })));
    fs.writeFileSync(backupPath, JSON.stringify(touched, null, 2));
    console.log(`Backup of ${touched.length} affected doc(s) written to ${backupPath}`);
    console.log("");
  }

  let deletions = 0;
  for (const [phone, list] of groups) {
    list.sort((a, b) => score(b) - score(a));
    const [winner, ...losers] = list;
    console.log(`${phone}  (${list.length} records)`);
    console.log(`   KEEP   ${winner.id}  name=${JSON.stringify(winner.name || "")} addr=${JSON.stringify(winner.address || "")} created=${winner.createdAt || "-"}`);
    for (const l of losers) {
      console.log(`   DELETE ${l.id}  name=${JSON.stringify(l.name || "")} addr=${JSON.stringify(l.address || "")} created=${l.createdAt || "-"}`);
      deletions += 1;
    }

    if (APPLY) {
      const merged = { ...winner };
      for (const l of losers) {
        for (const f of ["name", "address", "email", "notes", "contactDetails", "mobile", "mobileDigits", "phone"]) {
          merged[f] = fill(merged, l, f);
        }
      }
      merged.updatedAt = new Date().toISOString();
      const batch = db.batch();
      batch.set(db.collection("customers").doc(winner.id), merged);
      for (const l of losers) batch.delete(db.collection("customers").doc(l.id));
      await batch.commit();
      console.log("   -> merged and deleted");
    }
  }

  console.log("");
  console.log(APPLY
    ? `APPLIED. Deleted ${deletions} duplicate record(s).`
    : `DRY RUN. Would delete ${deletions} duplicate record(s). Re-run with --apply to do it.`);
})().catch((e) => { console.error(e); process.exit(1); });
