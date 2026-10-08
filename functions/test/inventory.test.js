const test = require("node:test");
const assert = require("node:assert/strict");
const { planStockCommit } = require("../src/inventory");

function phone() {
  return {
    id: "phone-1",
    name: "Flip phone",
    requiresImei: false,
    stock: {
      Brooklyn: { quantity: 5, imeis: [] },
      Monroe: { quantity: 10, imeis: [] },
    },
    quantity: 15,
    imeis: [],
  };
}

test("a Monroe sale keeps Brooklyn's count", () => {
  const { products, applied } = planStockCommit(
    { "phone-1": phone() },
    new Set(),
    [{
      id: "sale:s1:phone-1",
      productId: "phone-1",
      location: "Monroe",
      op: "removeQty",
      qty: 1,
      sourceType: "sale",
      sourceId: "s1",
    }],
  );
  assert.equal(products["phone-1"].stock.Brooklyn.quantity, 5);
  assert.equal(products["phone-1"].stock.Monroe.quantity, 9);
  assert.equal(products["phone-1"].quantity, 14);
  assert.equal(applied.length, 1);
});

test("two stores selling together each keep the other's new count", () => {
  const first = planStockCommit(
    { "phone-1": phone() },
    new Set(),
    [{
      id: "sale:brooklyn:phone-1",
      productId: "phone-1",
      location: "Brooklyn",
      op: "removeQty",
      qty: 1,
    }],
  );
  const second = planStockCommit(
    first.products,
    new Set(first.applied.map((entry) => entry.movement.id)),
    [{
      id: "sale:monroe:phone-1",
      productId: "phone-1",
      location: "Monroe",
      op: "removeQty",
      qty: 1,
    }],
  );
  assert.equal(second.products["phone-1"].stock.Brooklyn.quantity, 4);
  assert.equal(second.products["phone-1"].stock.Monroe.quantity, 9);
});

test("the same sale applied twice does not subtract twice", () => {
  const seen = new Set();
  const movement = {
    id: "sale:s1:phone-1",
    productId: "phone-1",
    location: "Monroe",
    op: "removeQty",
    qty: 1,
  };
  const first = planStockCommit({ "phone-1": phone() }, seen, [movement]);
  const second = planStockCommit(first.products, seen, [movement]);
  assert.equal(second.products["phone-1"].stock.Monroe.quantity, 9);
  assert.equal(second.skipped.length, 1);
});

test("selling one IMEI leaves the other store's phones in place", () => {
  const product = {
    id: "phone-1",
    requiresImei: true,
    stock: {
      Brooklyn: { quantity: 1, imeis: ["111"] },
      Monroe: { quantity: 2, imeis: ["222", "333"] },
    },
  };
  const { products } = planStockCommit(
    { "phone-1": product },
    new Set(),
    [{
      id: "sale:s1:phone-1",
      productId: "phone-1",
      location: "Monroe",
      op: "removeImeis",
      imeis: ["222"],
    }],
  );
  assert.deepEqual(products["phone-1"].stock.Brooklyn.imeis, ["111"]);
  assert.deepEqual(products["phone-1"].stock.Monroe.imeis, ["333"]);
  assert.equal(products["phone-1"].quantity, 2);
});

test("a count sets one store and leaves the other", () => {
  const { products } = planStockCommit(
    { "phone-1": phone() },
    new Set(),
    [{
      id: "count:phone-1:1",
      productId: "phone-1",
      location: "Brooklyn",
      op: "set",
      qty: 2,
    }],
  );
  assert.equal(products["phone-1"].stock.Brooklyn.quantity, 2);
  assert.equal(products["phone-1"].stock.Monroe.quantity, 10);
});
