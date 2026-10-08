import { describe, expect, it } from "vitest";
import { buildRepairIntakeReceipt, buildSaleReceipt, type ReceiptBranding } from "../src/receipts.js";

const branding: ReceiptBranding = {
  companyName: "Diamant Telecom",
  phone: "1 (347) 388-7467",
  web: "diamanttelecom.com",
  storeName: "Brooklyn Store",
  storeAddress: "803 Bedford Ave",
  storePhone: "(347) 388-7467",
  storeHours: "Mon-Thu",
  currency: "USD",
  notes: { repair: "Parts are held 30 days." },
};

describe("repair intake receipt", () => {
  const doc = buildRepairIntakeReceipt(
    {
      ticket: "100234",
      createdAt: new Date("2026-10-07T15:00:00Z"),
      timeZone: "America/New_York",
      customerName: "Avi Cohen",
      customerPhone: "+13473887467",
      model: "Kyocera E4610",
      imei: "352099001761481",
      issue: "Screen",
      fixes: [{ description: "Charge port", priceCents: 3500 }],
      estimateCents: 9000,
      amountDueCents: 12500,
      paid: false,
      servedByName: "Moshe Glick",
      status: "received",
      devicePasscode: "4321",
    },
    branding,
  );

  it("prints two pages with the same ticket", () => {
    expect(doc.pages.map((p) => p.name)).toEqual(["customer_copy", "device_label"]);
    for (const page of doc.pages) {
      expect(page.blocks).toContainEqual({ type: "big", text: "100234" });
    }
  });

  it("never puts the passcode on the customer copy", () => {
    const customer = JSON.stringify(doc.pages[0]);
    const label = JSON.stringify(doc.pages[1]);
    expect(customer).not.toContain("4321");
    expect(label).toContain("PIN: 4321");
  });

  it("uses initials for staff and includes the tenant note", () => {
    const customer = JSON.stringify(doc.pages[0]);
    expect(customer).toContain("M.G.");
    expect(customer).not.toContain("Moshe Glick");
    expect(customer).toContain("Parts are held 30 days.");
  });
});

describe("sale receipt", () => {
  it("shows tax rate, tenders and balance due", () => {
    const doc = buildSaleReceipt(
      {
        receiptCode: "AB12CD34",
        createdAt: new Date("2026-10-07T15:00:00Z"),
        timeZone: "America/New_York",
        kind: "sale",
        lines: [{ name: "Charger", qty: 1, netCents: 2500 }],
        subtotalCents: 2500,
        taxCents: 222,
        taxRatePpm: 88_750,
        totalCents: 2722,
        tenders: [{ label: "Cash", amountCents: 1000 }],
        balanceDueCents: 1722,
        balanceDueDate: "2026-10-20",
      },
      branding,
    );
    const text = JSON.stringify(doc);
    expect(text).toContain("Tax (8.875%)");
    expect(text).toContain("Balance due 2026-10-20");
    expect(text).toContain("AB12CD34");
  });
});
