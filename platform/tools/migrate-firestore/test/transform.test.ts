import { describe, expect, it } from "vitest";
import { planMigration, reconcile, type FirestoreExport } from "../src/transform.js";

const STORES = { Brooklyn: "BKN", "Upstate NY": "UPS" };

const EXPORT: FirestoreExport = {
  customers: [
    { id: "c1", phone: "(347) 555-0101", name: "jane doe", balance: 12.5, balanceUpdatedAt: "2025-01-01T00:00:00Z" },
    { id: "c2", phone: "1-347-555-0101", name: "Jane D.", balance: "-2.25", email: "jane@x.test", balanceUpdatedAt: "2025-06-01T00:00:00Z" },
    { id: "c3", phone: "555-0101", name: "No Area Code", balance: 5 },
    { id: "c4", phone: "8456370687", name: "bob", balance: 0.1 + 0.2 },
  ],
  products: [
    { id: "p1", name: "USB-C cable", sku: "CAB-1", price: "9.99", stock: { Brooklyn: { quantity: 4 }, "Upstate NY": { quantity: 2 } } },
    { id: "p2", name: "iPhone 13", productType: "Phone", price: 499, stock: { Brooklyn: { imeis: ["356938035643809", "356938035643809", "352099001761481"] } } },
    { id: "p3", name: "Case", sku: "CAB-1", price: "$1,234.50", stock: { Queens: { quantity: 3 } } },
    { id: "p4", name: "Old item", price: 2, quantity: 1, location: "Brooklyn" },
  ],
  reports: [
    { id: "r1", type: "repair", createdAt: "2025-01-01", customerPhone: "3475550101", storeLocation: "Brooklyn", details: { ticketNumber: "100005", model: "iPhone 12", issue: "Screen", status: "Ready", price: "120" } },
    { id: "r2", type: "repair", createdAt: "2025-02-01", customerPhone: "3475550102", details: { ticketNumber: "100005", model: "Pixel", status: "Completed" } },
    { id: "r3", type: "repair", createdAt: "2025-03-01", details: { ticketNumber: "DT-77", ticketNumberWas: "77", model: "Galaxy", status: "In repair", price: "abc" } },
    { id: "s1", type: "sale", createdAt: "2025-01-01" },
  ],
};

describe("firestore migration plan", () => {
  const plan = planMigration(EXPORT, STORES);
  const report = reconcile(EXPORT, plan);

  it("dedupes customers by phone and carries every balance into the ledger in cents", () => {
    expect(plan.customers).toHaveLength(2);
    const jane = plan.customers.find((c) => c.phone === "+13475550101")!;
    expect(jane.sourceIds).toEqual(["c1", "c2"]);
    expect(jane.openingEntries).toEqual([
      { sourceId: "c1", amountCents: 1250 },
      { sourceId: "c2", amountCents: -225 },
    ]);
    // The most recently touched document wins the contact details.
    expect(jane.name).toBe("Jane D.");
    expect(jane.email).toBe("jane@x.test");
    const bob = plan.customers.find((c) => c.phone === "+18456370687")!;
    expect(bob.openingEntries).toEqual([{ sourceId: "c4", amountCents: 30 }]);
    expect(plan.issues.some((i) => i.sourceId === "c3" && i.severity === "error")).toBe(true);
  });

  it("maps store names to codes, converts prices to cents and keeps IMEIs", () => {
    const cable = plan.products.find((p) => p.sourceId === "p1")!;
    expect(cable.priceCents).toBe(999);
    expect(cable.stock).toEqual([
      { storeCode: "BKN", qty: 4, imeis: [] },
      { storeCode: "UPS", qty: 2, imeis: [] },
    ]);
    const phone = plan.products.find((p) => p.sourceId === "p2")!;
    expect(phone.serialized).toBe(true);
    expect(phone.stock[0]).toEqual({ storeCode: "BKN", qty: 2, imeis: ["356938035643809", "352099001761481"] });
    const dup = plan.products.find((p) => p.sourceId === "p3")!;
    expect(dup.sku).toBe("CAB-1-p3");
    expect(dup.priceCents).toBe(123450);
    expect(plan.products.find((p) => p.sourceId === "p4")!.stock).toEqual([{ storeCode: "BKN", qty: 1, imeis: [] }]);
  });

  it("keeps ticket numbers, renumbers clashes and legacy formats, and records aliases", () => {
    const [r1, r2, r3] = ["r1", "r2", "r3"].map((id) => plan.workOrders.find((w) => w.sourceId === id)!);
    expect(r1!.ticketNumber).toBe(100005);
    expect(r1!.renumbered).toBe(false);
    expect(r1!.status).toBe("ready");
    expect(r1!.priceCents).toBe(12000);
    expect(r2!.ticketNumber).toBe(100006);
    expect(r2!.aliases).toContain("100005");
    expect(r2!.status).toBe("picked_up");
    expect(r3!.ticketNumber).toBe(100007);
    expect(r3!.aliases).toEqual(expect.arrayContaining(["77"]));
    expect(r3!.priceCents).toBeNull();
    expect(plan.nextTicket).toBe(100008);
    expect(plan.workOrders).toHaveLength(3);
  });

  it("reconciles money and units in vs out", () => {
    expect(report.customers).toMatchObject({ sourceDocs: 4, migrated: 2, merged: 1, rejected: 1, balanced: true, ledgerCents: 1055 });
    expect(report.stock).toEqual({ sourceUnits: 12, migratedUnits: 9, unmigratedUnits: 3 });
    expect(report.repairs).toMatchObject({ sourceDocs: 3, migrated: 3, renumbered: 2 });
    expect(report.errors).toBeGreaterThan(0);
  });
});
