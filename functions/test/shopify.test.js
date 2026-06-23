const test = require("node:test");
const assert = require("node:assert/strict");
const { extractShopifyImei } = require("../src/shopify");

test("extractShopifyImei reads line item property", () => {
  const imei = extractShopifyImei({
    line_items: [
      {
        title: "iPhone 14",
        properties: [{ name: "IMEI", value: "356789012345678" }],
      },
    ],
  });

  assert.equal(imei, "356789012345678");
});

test("extractShopifyImei reads note attributes", () => {
  const imei = extractShopifyImei({
    note_attributes: [{ name: "Device IMEI", value: "356789012345678" }],
    line_items: [],
  });

  assert.equal(imei, "356789012345678");
});