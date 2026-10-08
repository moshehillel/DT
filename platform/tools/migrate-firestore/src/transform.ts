import {
  legacyStatusToWorkOrderStatus,
  legacyTicketAliases,
  normalizeUsPhone,
  parseMoney,
  parseTicketInput,
  TICKET_FIRST,
  TICKET_LAST,
  titleCaseName,
  type WorkOrderStatus,
} from "@pos/domain";

/**
 * Firestore export as produced by `firestore-export.json`: one array per
 * collection, plus the appState documents that hold lists (stores).
 * Everything is `unknown`-typed on purpose: the old documents were written by
 * many versions of the app and nothing about their shape can be trusted.
 */
export interface FirestoreExport {
  customers?: unknown[];
  products?: unknown[];
  reports?: unknown[];
  stores?: unknown[];
}

export interface StoreMapping {
  /** Old free-text store name (as stored on documents) -> new store code. */
  [legacyName: string]: string;
}

export interface Issue {
  severity: "error" | "warning";
  entity: "customer" | "product" | "repair" | "store";
  sourceId: string;
  message: string;
}

export interface PlannedCustomer {
  phone: string;
  name: string | null;
  email: string | null;
  address: string | null;
  sourceIds: string[];
  /** One opening entry per source document that carried a balance. Positive = credit the shop owes. */
  openingEntries: { sourceId: string; amountCents: number }[];
}

export interface PlannedProduct {
  sourceId: string;
  name: string;
  category: string;
  sku: string;
  barcode: string | null;
  priceCents: number;
  serialized: boolean;
  stock: { storeCode: string; qty: number; imeis: string[] }[];
}

export interface PlannedWorkOrder {
  sourceId: string;
  ticketNumber: number;
  /** Every number the repair answered to before, so the IVR and counter search still find it. */
  aliases: string[];
  renumbered: boolean;
  storeCode: string | null;
  customerPhone: string | null;
  customerName: string | null;
  model: string;
  imei: string | null;
  issue: string;
  status: WorkOrderStatus;
  priceCents: number | null;
  createdAt: string | null;
}

export interface MigrationPlan {
  customers: PlannedCustomer[];
  products: PlannedProduct[];
  workOrders: PlannedWorkOrder[];
  nextTicket: number;
  issues: Issue[];
}

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const opt = (value: unknown): string | null => str(value) || null;

function storeCodeFor(name: string, mapping: StoreMapping): string | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  for (const [legacy, code] of Object.entries(mapping)) {
    if (legacy.trim().toLowerCase() === wanted) return code;
  }
  return null;
}

export function planCustomers(rows: unknown[], issues: Issue[]): PlannedCustomer[] {
  const byPhone = new Map<string, PlannedCustomer & { latest: string }>();
  for (const raw of rows) {
    const doc = obj(raw);
    const sourceId = str(doc.id) || "(no id)";
    const phone = normalizeUsPhone(doc.phone ?? doc.customerPhone);
    if (!phone) {
      issues.push({ severity: "error", entity: "customer", sourceId, message: `phone "${str(doc.phone)}" is not a US number; not migrated` });
      continue;
    }
    const balanceRaw = doc.balance ?? 0;
    const balance = parseMoney(balanceRaw);
    if (balance === null) {
      issues.push({ severity: "error", entity: "customer", sourceId, message: `balance "${String(balanceRaw)}" is not money; treated as 0` });
    }
    const updated = str(doc.balanceUpdatedAt) || str(doc.updatedAt) || str(doc.createdAt);
    const existing = byPhone.get(phone);
    const name = str(doc.name) ? titleCaseName(doc.name) : null;
    if (!existing) {
      byPhone.set(phone, {
        phone,
        name,
        email: opt(doc.email),
        address: opt(doc.address),
        sourceIds: [sourceId],
        openingEntries: balance ? [{ sourceId, amountCents: balance }] : [],
        latest: updated,
      });
      continue;
    }
    // Duplicate customer documents for one phone: keep the most recently
    // touched contact details, and carry every balance into the one ledger.
    issues.push({ severity: "warning", entity: "customer", sourceId, message: `merged into ${existing.sourceIds[0]} (same phone ${phone})` });
    existing.sourceIds.push(sourceId);
    if (balance) existing.openingEntries.push({ sourceId, amountCents: balance });
    if (updated > existing.latest) {
      existing.latest = updated;
      existing.name = name ?? existing.name;
      existing.email = opt(doc.email) ?? existing.email;
      existing.address = opt(doc.address) ?? existing.address;
    } else {
      existing.name ??= name;
      existing.email ??= opt(doc.email);
      existing.address ??= opt(doc.address);
    }
  }
  return [...byPhone.values()].map(({ latest: _latest, ...customer }) => customer);
}

export function planProducts(rows: unknown[], mapping: StoreMapping, issues: Issue[]): PlannedProduct[] {
  const skus = new Set<string>();
  const planned: PlannedProduct[] = [];
  for (const raw of rows) {
    const doc = obj(raw);
    const sourceId = str(doc.id) || "(no id)";
    const name = str(doc.name) || str(doc.model);
    if (!name) {
      issues.push({ severity: "error", entity: "product", sourceId, message: "product has no name; not migrated" });
      continue;
    }
    const price = parseMoney(doc.price ?? doc.salePrice ?? 0);
    if (price === null) issues.push({ severity: "error", entity: "product", sourceId, message: `price "${String(doc.price)}" is not money; set to 0` });
    let sku = str(doc.sku) || str(doc.barcode) || `LEGACY-${sourceId}`;
    if (skus.has(sku)) {
      issues.push({ severity: "warning", entity: "product", sourceId, message: `duplicate SKU ${sku}; suffixed with the source id` });
      sku = `${sku}-${sourceId}`;
    }
    skus.add(sku);

    const stockSource = obj(doc.stock);
    const entries: [string, Record<string, unknown>][] = Object.keys(stockSource).length
      ? Object.entries(stockSource).map(([location, entry]) => [location, obj(entry)])
      : doc.quantity || doc.imeis
        ? [[str(doc.location), { quantity: doc.quantity, imeis: doc.imeis }]]
        : [];
    const stock: PlannedProduct["stock"] = [];
    let serialized = Boolean(doc.requiresImei) || /phone/i.test(str(doc.productType));
    for (const [location, entry] of entries) {
      const imeis = [...new Set((Array.isArray(entry.imeis) ? entry.imeis : []).map((v) => String(v).replace(/\D/g, "")).filter(Boolean))];
      if (imeis.length) serialized = true;
      const qty = imeis.length || Math.max(0, Math.trunc(Number(entry.quantity) || 0));
      if (!qty) continue;
      const storeCode = storeCodeFor(location, mapping);
      if (!storeCode) {
        issues.push({ severity: "error", entity: "product", sourceId, message: `stock at unknown store "${location}" (${qty}) not migrated` });
        continue;
      }
      stock.push({ storeCode, qty, imeis });
    }
    planned.push({
      sourceId,
      name,
      category: str(doc.category) || str(doc.productType) || "Other",
      sku,
      barcode: opt(doc.barcode),
      priceCents: price ?? 0,
      serialized,
      stock,
    });
  }
  return planned;
}

export function planWorkOrders(rows: unknown[], mapping: StoreMapping, issues: Issue[]): { workOrders: PlannedWorkOrder[]; nextTicket: number } {
  const repairs = rows
    .map(obj)
    .filter((doc) => doc.type === "repair")
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));

  const taken = new Set<number>();
  let max = TICKET_FIRST - 1;
  for (const doc of repairs) {
    const ticket = parseTicketInput(str(obj(doc.details).ticketNumber) || str(doc.ticketDigits));
    if (ticket !== null && ticket > max) max = ticket;
  }
  let next = max + 1;

  const workOrders: PlannedWorkOrder[] = [];
  for (const doc of repairs) {
    const details = obj(doc.details);
    const sourceId = str(doc.id) || "(no id)";
    const current = parseTicketInput(str(details.ticketNumber) || str(doc.ticketDigits));
    let ticketNumber: number;
    let renumbered = false;
    if (current !== null && !taken.has(current)) {
      ticketNumber = current;
    } else {
      // Clash or legacy format: the oldest repair keeps the number, this one
      // gets a fresh one and keeps the old number as an alias.
      if (next > TICKET_LAST) throw new Error("ran out of 6-digit ticket numbers");
      ticketNumber = next;
      next += 1;
      renumbered = true;
      issues.push({
        severity: "warning",
        entity: "repair",
        sourceId,
        message: `ticket "${str(details.ticketNumber)}" ${current === null ? "is not a 6-digit ticket" : "is used by an older repair"}; renumbered ${ticketNumber}`,
      });
    }
    taken.add(ticketNumber);
    const aliases = legacyTicketAliases(doc as Parameters<typeof legacyTicketAliases>[0]).filter((a) => a !== String(ticketNumber));

    const storeName = str(doc.storeLocation) || str(doc.location) || str(details.store);
    const storeCode = storeCodeFor(storeName, mapping);
    if (storeName && !storeCode) issues.push({ severity: "warning", entity: "repair", sourceId, message: `unknown store "${storeName}"` });
    const priceRaw = details.price ?? details.repairPrice ?? doc.paymentAmount;
    const price = priceRaw === undefined || priceRaw === "" ? null : parseMoney(priceRaw);
    if (priceRaw !== undefined && priceRaw !== "" && price === null) {
      issues.push({ severity: "warning", entity: "repair", sourceId, message: `price "${String(priceRaw)}" is not money; left blank` });
    }
    workOrders.push({
      sourceId,
      ticketNumber,
      aliases,
      renumbered,
      storeCode,
      customerPhone: normalizeUsPhone(doc.customerPhone),
      customerName: str(details.customerName) ? titleCaseName(details.customerName) : null,
      model: str(details.model) || "Unknown device",
      imei: opt(details.imei),
      issue: str(details.issue) || str(details.problem) || str(doc.notes) || "(not recorded)",
      status: legacyStatusToWorkOrderStatus(str(details.status) || "Received"),
      priceCents: price,
      createdAt: opt(doc.createdAt),
    });
  }
  return { workOrders, nextTicket: next };
}

export function planMigration(data: FirestoreExport, mapping: StoreMapping): MigrationPlan {
  const issues: Issue[] = [];
  const customers = planCustomers(data.customers ?? [], issues);
  const products = planProducts(data.products ?? [], mapping, issues);
  const { workOrders, nextTicket } = planWorkOrders(data.reports ?? [], mapping, issues);
  return { customers, products, workOrders, nextTicket, issues };
}

export interface Reconciliation {
  customers: { sourceDocs: number; migrated: number; merged: number; rejected: number; sourceBalanceCents: number; ledgerCents: number; balanced: boolean };
  stock: { sourceUnits: number; migratedUnits: number; unmigratedUnits: number };
  repairs: { sourceDocs: number; migrated: number; renumbered: number; aliases: number };
  errors: number;
  warnings: number;
}

/** Totals in vs out, so a dry run proves nothing (money, units, tickets) was silently dropped. */
export function reconcile(data: FirestoreExport, plan: MigrationPlan): Reconciliation {
  const sourceCustomers = (data.customers ?? []).map(obj);
  const sourceBalanceCents = sourceCustomers
    .filter((c) => normalizeUsPhone(c.phone ?? c.customerPhone))
    .reduce((sum, c) => sum + (parseMoney(c.balance ?? 0) ?? 0), 0);
  const ledgerCents = plan.customers.reduce((sum, c) => sum + c.openingEntries.reduce((s, e) => s + e.amountCents, 0), 0);
  const migratedSourceIds = plan.customers.reduce((n, c) => n + c.sourceIds.length, 0);

  let sourceUnits = 0;
  for (const raw of data.products ?? []) {
    const doc = obj(raw);
    const stock = obj(doc.stock);
    const entries = Object.keys(stock).length ? Object.values(stock).map(obj) : [{ quantity: doc.quantity, imeis: doc.imeis }];
    for (const entry of entries) {
      const imeis = Array.isArray(entry.imeis) ? new Set(entry.imeis.map((v) => String(v).replace(/\D/g, "")).filter(Boolean)).size : 0;
      sourceUnits += imeis || Math.max(0, Math.trunc(Number(entry.quantity) || 0));
    }
  }
  const migratedUnits = plan.products.reduce((sum, p) => sum + p.stock.reduce((s, e) => s + e.qty, 0), 0);
  const sourceRepairs = (data.reports ?? []).map(obj).filter((r) => r.type === "repair").length;

  return {
    customers: {
      sourceDocs: sourceCustomers.length,
      migrated: plan.customers.length,
      merged: migratedSourceIds - plan.customers.length,
      rejected: sourceCustomers.length - migratedSourceIds,
      sourceBalanceCents,
      ledgerCents,
      balanced: sourceBalanceCents === ledgerCents,
    },
    stock: { sourceUnits, migratedUnits, unmigratedUnits: sourceUnits - migratedUnits },
    repairs: {
      sourceDocs: sourceRepairs,
      migrated: plan.workOrders.length,
      renumbered: plan.workOrders.filter((w) => w.renumbered).length,
      aliases: plan.workOrders.reduce((n, w) => n + w.aliases.length, 0),
    },
    errors: plan.issues.filter((i) => i.severity === "error").length,
    warnings: plan.issues.filter((i) => i.severity === "warning").length,
  };
}
