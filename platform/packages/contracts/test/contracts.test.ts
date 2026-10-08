import { describe, expect, it } from "vitest";
import { CreateSaleCommand, CreateWorkOrderCommand } from "../src/index.js";

const uuid = "8f7f8c3e-2a7b-4b8e-9a51-0c1b2d3e4f50";

describe("contracts", () => {
  it("rejects float money", () => {
    const result = CreateSaleCommand.safeParse({
      storeId: uuid,
      lines: [{ kind: "custom", description: "x", qty: 1, unitPriceCents: 10.5 }],
      tenders: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a split-tender sale", () => {
    const result = CreateSaleCommand.safeParse({
      storeId: uuid,
      lines: [{ kind: "product", variantId: uuid, qty: 1 }],
      tenders: [
        { method: "cash", amountCents: 1000 },
        { method: "card", amountCents: 1722 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("defaults repair intake flags", () => {
    const parsed = CreateWorkOrderCommand.parse({ storeId: uuid, model: "Kyocera", issue: "Screen" });
    expect(parsed.notifyBy).toBe("sms");
    expect(parsed.fixes).toEqual([]);
  });
});
