const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSeed, compareInventory, costOf } = require("../src/inventoryPg");

const phone = {
  id: "p1",
  name: "Phone",
  requiresImei: true,
  cost: "120.50",
  stock: { Monroe: { quantity: 2, imeis: ["111", "222"] }, Brooklyn: { quantity: 1, imeis: ["333"] } },
};
const cable = {
  id: "c1",
  name: "Cable",
  cost: 3,
  stock: { Monroe: { quantity: 7, imeis: [] }, Brooklyn: { quantity: 0, imeis: [] } },
};

test("seed takes counts per store and every IMEI at the product's cost", () => {
  const seed = buildSeed([phone, cable]);
  assert.deepEqual(seed.levels, [
    { productId: "c1", location: "Monroe", quantity: 7 },
    { productId: "c1", location: "Brooklyn", quantity: 0 },
  ]);
  assert.deepEqual(seed.units.map((unit) => [unit.imei, unit.location, unit.cost]), [
    ["111", "Monroe", 120.5],
    ["222", "Monroe", 120.5],
    ["333", "Brooklyn", 120.5],
  ]);
  assert.deepEqual(seed.duplicates, []);
});

test("seed keeps the first place of an IMEI listed twice and reports it", () => {
  const other = { id: "p2", requiresImei: true, stock: { Brooklyn: { quantity: 1, imeis: ["111"] } } };
  const seed = buildSeed([phone, other]);
  assert.equal(seed.units.filter((unit) => unit.imei === "111").length, 1);
  assert.deepEqual(seed.duplicates, [{ imei: "111", productId: "p2", location: "Brooklyn", keptAt: "Monroe" }]);
});

test("seed reads older products that only have one location", () => {
  const seed = buildSeed([{ id: "old", quantity: 4, location: "Monroe" }]);
  assert.deepEqual(seed.levels, [{ productId: "old", location: "Monroe", quantity: 4 }]);
});

test("cost is rounded to cents and blank cost stays empty", () => {
  assert.equal(costOf({ cost: "9.999" }), 10);
  assert.equal(costOf({ cost: "" }), null);
  assert.equal(costOf({}), null);
});

test("matching stock reports nothing", () => {
  const stored = {
    levels: [
      { product_id: "c1", location: "Monroe", quantity: 7 },
      { product_id: "c1", location: "Brooklyn", quantity: 0 },
    ],
    units: [
      { imei: "222", product_id: "p1", location: "Monroe" },
      { imei: "111", product_id: "p1", location: "Monroe" },
      { imei: "333", product_id: "p1", location: "Brooklyn" },
    ],
  };
  assert.deepEqual(compareInventory([phone, cable], stored), []);
});

test("different counts and IMEIs are reported per store", () => {
  const stored = {
    levels: [{ product_id: "c1", location: "Monroe", quantity: 6 }, { product_id: "c1", location: "Lakewood", quantity: 2 }],
    units: [
      { imei: "111", product_id: "p1", location: "Monroe" },
      { imei: "999", product_id: "p1", location: "Monroe" },
      { imei: "333", product_id: "p1", location: "Brooklyn" },
    ],
  };
  const differences = compareInventory([phone, cable], stored);
  assert.deepEqual(differences, [
    { productId: "p1", name: "Phone", location: "Monroe", onlyInFirestore: ["222"], onlyInPostgres: ["999"] },
    { productId: "c1", name: "Cable", location: "Monroe", firestore: 7, postgres: 6 },
    { productId: "c1", name: "Cable", location: "Lakewood", firestore: 0, postgres: 2 },
  ]);
});
