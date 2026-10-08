// Stock in PostgreSQL. While Firestore is still the official stock, every
// movement the server applies there is applied here too, with the same rules:
// a sale is never blocked, counts never go below zero (the shortfall is
// recorded), a sold IMEI comes off whichever store holds it, and a movement id
// already applied is skipped.

const { stockMapOf } = require("./inventory");

const SCHEMA = `
create table if not exists inv_stock_levels (
  product_id text not null,
  location text not null,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (product_id, location)
);
create table if not exists inv_phone_units (
  imei text primary key,
  product_id text not null,
  location text,
  status text not null check (status in ('in_stock', 'sold', 'removed')),
  cost numeric(12, 2),
  received_at timestamptz,
  sold_at timestamptz,
  sold_source_type text,
  sold_source_id text,
  updated_at timestamptz not null default now()
);
create index if not exists inv_phone_units_stock_idx on inv_phone_units (product_id, location, status);
create table if not exists inv_movements (
  id text primary key,
  product_id text not null,
  location text not null,
  op text not null,
  qty integer not null default 0,
  imeis text[] not null default '{}',
  source_type text,
  source_id text,
  short_qty integer not null default 0,
  missing_imeis text[] not null default '{}',
  unit_cost numeric(12, 2),
  origin text not null default 'register',
  applied_at timestamptz not null default now()
);
create index if not exists inv_movements_product_idx on inv_movements (product_id, location, applied_at);
create table if not exists inv_transfers (
  id text primary key,
  from_location text not null,
  to_location text not null,
  created_by text,
  created_at timestamptz not null default now(),
  lines jsonb not null
);
alter table inv_movements add column if not exists cost_total numeric(12, 2);
create table if not exists inv_avg_cost (
  product_id text primary key,
  avg_cost numeric(12, 4),
  updated_at timestamptz not null default now()
);
create table if not exists inv_product_versions (
  product_id text primary key,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists inv_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
`;

function costOf(product) {
  const value = Number.parseFloat(product?.cost);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function cleanImei(value) {
  return String(value || "").replace(/\D/g, "");
}

async function inTransaction(pool, schema, work) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local search_path to ${schema}, public`);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureInventorySchema(pool, schema = "public") {
  await inTransaction(pool, schema, (client) => client.query(SCHEMA));
}

// What the starting fill writes for the products as they stand in Firestore.
// An IMEI listed twice keeps its first place and is reported.
function buildSeed(products) {
  const levels = [];
  const units = new Map();
  const duplicates = [];
  const averages = [];
  for (const product of products) {
    if (!product.requiresImei) averages.push({ productId: product.id, cost: costOf(product) });
    const map = stockMapOf(product);
    for (const [location, entry] of Object.entries(map)) {
      if (!location) continue;
      if (product.requiresImei) {
        for (const raw of entry.imeis || []) {
          const imei = cleanImei(raw);
          if (!imei) continue;
          if (units.has(imei)) {
            duplicates.push({ imei, productId: product.id, location, keptAt: units.get(imei).location });
            continue;
          }
          units.set(imei, { imei, productId: product.id, location, cost: costOf(product) });
        }
      } else {
        levels.push({ productId: product.id, location, quantity: Math.max(0, Math.round(Number(entry.quantity) || 0)) });
      }
    }
  }
  return { levels, units: [...units.values()], duplicates, averages };
}

// Average cost of a counted product across every store, from its current cost
// of goods. Products already given an average keep theirs.
async function seedAverageCosts(client, averages) {
  for (const entry of averages) {
    await client.query(
      "insert into inv_avg_cost (product_id, avg_cost) values ($1, $2) on conflict (product_id) do nothing",
      [entry.productId, entry.cost],
    );
  }
}

async function ensureAverageCosts(pool, products, schema = "public") {
  const { averages } = buildSeed(products);
  await inTransaction(pool, schema, (client) => seedAverageCosts(client, averages));
}

async function seedInventory(pool, products, schema = "public") {
  const seed = buildSeed(products);
  return inTransaction(pool, schema, async (client) => {
    const already = await client.query("select value from inv_meta where key = 'seeded' for update");
    if (already.rows.length) return { seeded: false, reason: "already seeded", at: already.rows[0].value };
    for (const level of seed.levels) {
      await client.query(
        `insert into inv_stock_levels (product_id, location, quantity) values ($1, $2, $3)
         on conflict (product_id, location) do update set quantity = excluded.quantity, updated_at = now()`,
        [level.productId, level.location, level.quantity],
      );
    }
    for (const unit of seed.units) {
      await client.query(
        `insert into inv_phone_units (imei, product_id, location, status, cost, received_at)
         values ($1, $2, $3, 'in_stock', $4, null)
         on conflict (imei) do nothing`,
        [unit.imei, unit.productId, unit.location, unit.cost],
      );
    }
    await seedAverageCosts(client, seed.averages);
    const value = {
      at: new Date().toISOString(),
      levels: seed.levels.length,
      units: seed.units.length,
      duplicates: seed.duplicates,
    };
    await client.query("insert into inv_meta (key, value) values ('seeded', $1)", [value]);
    return { seeded: true, ...value };
  });
}

async function isSeeded(pool, schema = "public") {
  return inTransaction(pool, schema, async (client) => {
    const result = await client.query("select 1 from inv_meta where key = 'seeded'");
    return result.rows.length > 0;
  });
}

async function averageCost(client, productId, productCost) {
  await client.query(
    "insert into inv_avg_cost (product_id, avg_cost) values ($1, $2) on conflict (product_id) do nothing",
    [productId, productCost ?? null],
  );
  const row = await client.query("select avg_cost from inv_avg_cost where product_id = $1 for update", [productId]);
  const value = row.rows[0]?.avg_cost;
  return value === null || value === undefined ? null : Number(value);
}

// unitCost is what staff typed on a restock (null when nothing was typed);
// productCost is the product's cost of goods, used when there is nothing better.
async function applyOne(client, item, origin) {
  const { movement, requiresImei } = item;
  const unitCost = item.unitCost ?? null;
  const productCost = item.productCost ?? null;
  let costTotal = null;
  const claimed = await client.query(
    `insert into inv_movements (id, product_id, location, op, qty, imeis, source_type, source_id, unit_cost, origin)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (id) do nothing returning id`,
    [movement.id, movement.productId, movement.location, movement.op, movement.qty || 0, movement.imeis || [],
      movement.sourceType || null, movement.sourceId || null, unitCost ?? null, origin],
  );
  if (!claimed.rows.length) return { id: movement.id, skipped: true };

  let shortQty = 0;
  const missingImeis = [];
  const { productId, location, op } = movement;
  const imeis = (movement.imeis || []).map(cleanImei).filter(Boolean);
  const otherProducts = [];
  if (requiresImei && imeis.length && (op === "addImeis" || op === "set")) {
    const taken = await client.query(
      `select distinct product_id from inv_phone_units
       where imei = any($1::text[]) and product_id <> $2 and status = 'in_stock'`,
      [imeis, productId],
    );
    otherProducts.push(...taken.rows.map((row) => row.product_id));
  }

  if (requiresImei && (op === "addQty" || op === "removeQty")) {
    // A phone product only moves by IMEI, and a counted product only by count.
    // A movement of the other kind is kept on record and changes nothing.
    if (op === "removeQty") shortQty = movement.qty || 0;
  } else if (!requiresImei && (op === "addImeis" || op === "removeImeis")) {
    if (op === "removeImeis") missingImeis.push(...imeis);
  } else if (op === "addQty" || op === "removeQty" || (op === "set" && !requiresImei)) {
    await client.query(
      `insert into inv_stock_levels (product_id, location, quantity) values ($1, $2, 0)
       on conflict (product_id, location) do nothing`,
      [productId, location],
    );
    const current = await client.query(
      "select quantity from inv_stock_levels where product_id = $1 and location = $2 for update",
      [productId, location],
    );
    const have = Number(current.rows[0]?.quantity) || 0;
    let next = have;
    if (op === "addQty") {
      next = have + movement.qty;
      // Stock bought at a typed cost moves the average; stock coming back
      // (a return, a cancelled order, a transfer in) comes back at the average.
      const average = await averageCost(client, productId, productCost);
      if (unitCost !== null) {
        const total = await client.query(
          "select coalesce(sum(quantity), 0) as total from inv_stock_levels where product_id = $1",
          [productId],
        );
        const onHand = Number(total.rows[0].total) || 0;
        const blended = average === null || onHand <= 0
          ? unitCost
          : (average * onHand + unitCost * movement.qty) / (onHand + movement.qty);
        await client.query(
          "update inv_avg_cost set avg_cost = $2, updated_at = now() where product_id = $1",
          [productId, Math.round(blended * 10000) / 10000],
        );
      }
    } else if (op === "removeQty") {
      shortQty = Math.max(0, movement.qty - have);
      next = Math.max(0, have - movement.qty);
      const average = await averageCost(client, productId, productCost);
      if (average !== null) costTotal = Math.round(average * (movement.qty - shortQty) * 100) / 100;
    } else next = Math.max(0, movement.qty || 0);
    await client.query(
      "update inv_stock_levels set quantity = $3, updated_at = now() where product_id = $1 and location = $2",
      [productId, location, next],
    );
  } else if (op === "removeImeis") {
    let soldCost = 0;
    let anyCost = false;
    for (const imei of imeis) {
      const sold = await client.query(
        `update inv_phone_units set status = 'sold', sold_at = now(), sold_source_type = $2, sold_source_id = $3, updated_at = now()
         where imei = $1 and product_id = $4 and status = 'in_stock' returning cost`,
        [imei, movement.sourceType || null, movement.sourceId || null, productId],
      );
      if (!sold.rows.length) missingImeis.push(imei);
      else if (sold.rows[0].cost !== null) {
        soldCost += Number(sold.rows[0].cost);
        anyCost = true;
      }
    }
    if (anyCost) costTotal = Math.round(soldCost * 100) / 100;
  } else if (op === "addImeis") {
    // A typed cost is this handset's cost. Without one, a handset coming back
    // keeps the cost it had, and a new one takes the product's cost of goods.
    for (const imei of imeis) {
      await client.query(
        `insert into inv_phone_units (imei, product_id, location, status, cost, received_at)
         values ($1, $2, $3, 'in_stock', coalesce($4::numeric, $5::numeric), now())
         on conflict (imei) do update set
           product_id = excluded.product_id,
           location = excluded.location,
           status = 'in_stock',
           cost = coalesce($4::numeric, inv_phone_units.cost, $5::numeric),
           received_at = coalesce(inv_phone_units.received_at, excluded.received_at),
           sold_at = null, sold_source_type = null, sold_source_id = null,
           updated_at = now()`,
        [imei, productId, location, unitCost, productCost],
      );
    }
  } else if (op === "set" && requiresImei) {
    await client.query(
      `update inv_phone_units set status = 'removed', updated_at = now()
       where product_id = $1 and location = $2 and status = 'in_stock' and not (imei = any($3::text[]))`,
      [productId, location, imeis],
    );
    for (const imei of imeis) {
      await client.query(
        `insert into inv_phone_units (imei, product_id, location, status, cost, received_at)
         values ($1, $2, $3, 'in_stock', $4, now())
         on conflict (imei) do update set
           product_id = excluded.product_id, location = excluded.location, status = 'in_stock',
           cost = coalesce(inv_phone_units.cost, excluded.cost), updated_at = now()`,
        [imei, productId, location, unitCost ?? productCost],
      );
    }
  }

  if (shortQty || missingImeis.length || costTotal !== null) {
    await client.query(
      "update inv_movements set short_qty = $2, missing_imeis = $3, cost_total = $4 where id = $1",
      [movement.id, shortQty, missingImeis, costTotal],
    );
  }
  return { id: movement.id, skipped: false, shortQty, missingImeis, otherProducts };
}

async function stockOf(client, productIds) {
  const levels = await client.query(
    "select product_id, location, quantity from inv_stock_levels where product_id = any($1::text[])",
    [productIds],
  );
  const units = await client.query(
    `select product_id, location, imei from inv_phone_units
     where product_id = any($1::text[]) and status = 'in_stock' order by received_at nulls first, imei`,
    [productIds],
  );
  const byProduct = new Map(productIds.map((id) => [id, { levels: {}, imeis: {} }]));
  for (const row of levels.rows) byProduct.get(row.product_id).levels[row.location] = Number(row.quantity) || 0;
  for (const row of units.rows) {
    const entry = byProduct.get(row.product_id).imeis;
    (entry[row.location] = entry[row.location] || []).push(row.imei);
  }
  return byProduct;
}

// The product's stock as the registers show it, built from PostgreSQL. Stores
// already on the product keep their place at zero, so nothing drops off a list.
function stockFieldsFor(product, pgStock) {
  const requiresImei = Boolean(product?.requiresImei);
  const stock = {};
  for (const location of Object.keys(stockMapOf(product))) {
    if (location) stock[location] = { quantity: 0, imeis: [] };
  }
  if (requiresImei) {
    for (const [location, imeis] of Object.entries(pgStock.imeis)) stock[location] = { quantity: imeis.length, imeis };
  } else {
    for (const [location, quantity] of Object.entries(pgStock.levels)) stock[location] = { quantity, imeis: [] };
  }
  const imeis = requiresImei ? Object.values(stock).flatMap((entry) => entry.imeis) : [];
  const quantity = requiresImei ? imeis.length : Object.values(stock).reduce((sum, entry) => sum + entry.quantity, 0);
  return { stock, quantity, imeis, location: "" };
}

// PostgreSQL as the official stock. Every product in the request (and any
// product a moved IMEI came from) gets a new version and its resulting stock,
// so the Firestore copy can be written in order.
async function commitOfficialStock(pool, items, { schema = "public", origin = "register" } = {}) {
  return inTransaction(pool, schema, async (client) => {
    const requested = [...new Set(items.map((item) => item.movement.productId))].sort();
    for (const productId of requested) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 1))", [`stock/${productId}`]);
    }
    const results = [];
    const touched = new Set(requested);
    for (const item of items) {
      const result = await applyOne(client, item, origin);
      results.push(result);
      for (const other of result.otherProducts || []) touched.add(other);
    }
    const productIds = [...touched].sort();
    const versions = new Map();
    for (const productId of productIds) {
      const bumped = await client.query(
        `insert into inv_product_versions (product_id, version) values ($1, 1)
         on conflict (product_id) do update set version = inv_product_versions.version + 1, updated_at = now()
         returning version`,
        [productId],
      );
      versions.set(productId, Number(bumped.rows[0].version));
    }
    return { results, versions, stock: await stockOf(client, productIds) };
  });
}

// items: [{ movement, requiresImei, unitCost }] in the order they were applied.
async function applyMovementsPg(pool, items, { schema = "public", origin = "register" } = {}) {
  if (!items.length) return [];
  return inTransaction(pool, schema, async (client) => {
    const results = [];
    for (const item of items) results.push(await applyOne(client, item, origin));
    return results;
  });
}

// What one product has at each store right now, from the official stock.
async function availableStock(pool, productId, schema = "public") {
  return inTransaction(pool, schema, async (client) => (await stockOf(client, [productId])).get(productId));
}

// Stock on hand at cost: phones at the cost of each handset, counted items at
// their average cost. Units with no cost known are counted apart.
async function stockValue(pool, schema = "public") {
  return inTransaction(pool, schema, async (client) => {
    const phones = await client.query(
      `select product_id, location, count(*)::int as units, coalesce(sum(cost), 0) as value,
              count(*) filter (where cost is null)::int as no_cost
       from inv_phone_units where status = 'in_stock' group by product_id, location`,
    );
    const counted = await client.query(
      `select l.product_id, l.location, l.quantity as units, a.avg_cost
       from inv_stock_levels l left join inv_avg_cost a using (product_id)
       where l.quantity > 0`,
    );
    const rows = [
      ...phones.rows.map((row) => ({
        productId: row.product_id,
        location: row.location,
        units: Number(row.units),
        value: Math.round(Number(row.value) * 100) / 100,
        unitsWithoutCost: Number(row.no_cost),
        method: "each",
      })),
      ...counted.rows.map((row) => {
        const average = row.avg_cost === null ? null : Number(row.avg_cost);
        return {
          productId: row.product_id,
          location: row.location,
          units: Number(row.units),
          value: average === null ? 0 : Math.round(average * Number(row.units) * 100) / 100,
          unitsWithoutCost: average === null ? Number(row.units) : 0,
          averageCost: average === null ? null : Math.round(average * 100) / 100,
          method: "average",
        };
      }),
    ];
    return rows;
  });
}

// What the stock sold in each sale and phone order cost, with the sale's own
// record so its price can sit beside the cost.
async function saleCosts(pool, { from, to }, schema = "public") {
  return inTransaction(pool, schema, async (client) => {
    const result = await client.query(
      `select m.source_type, m.source_id, min(m.applied_at) as at,
              sum(m.cost_total) as cost, bool_or(m.cost_total is null and m.short_qty = 0) as missing_cost,
              (array_agg(r.data))[1] as record
       from inv_movements m
       left join records r
         on r.collection = case m.source_type when 'sale' then 'reports' else 'phoneOrders' end
        and r.id = m.source_id
       where m.source_type in ('sale', 'order') and m.op in ('removeQty', 'removeImeis')
         and m.applied_at >= $1::timestamptz and m.applied_at < $2::timestamptz
       group by m.source_type, m.source_id
       order by at desc
       limit 1000`,
      [from, to],
    );
    return result.rows.map((row) => ({
      sourceType: row.source_type,
      sourceId: row.source_id,
      at: row.at instanceof Date ? row.at.toISOString() : row.at,
      cost: row.cost === null ? null : Math.round(Number(row.cost) * 100) / 100,
      missingCost: Boolean(row.missing_cost),
      record: row.record || null,
    }));
  });
}

async function readInventory(pool, schema = "public") {
  return inTransaction(pool, schema, async (client) => {
    const levels = await client.query("select product_id, location, quantity from inv_stock_levels");
    const units = await client.query("select imei, product_id, location from inv_phone_units where status = 'in_stock'");
    return { levels: levels.rows, units: units.rows };
  });
}

// Every product's count and IMEIs per store, Firestore against PostgreSQL.
function compareInventory(products, { levels, units }) {
  const qtyByKey = new Map(levels.map((row) => [`${row.product_id}\u0001${row.location}`, Number(row.quantity) || 0]));
  const imeisByKey = new Map();
  for (const unit of units) {
    const key = `${unit.product_id}\u0001${unit.location}`;
    if (!imeisByKey.has(key)) imeisByKey.set(key, []);
    imeisByKey.get(key).push(unit.imei);
  }
  const differences = [];
  for (const product of products) {
    const map = stockMapOf(product);
    const locations = new Set(Object.keys(map).filter(Boolean));
    for (const key of [...qtyByKey.keys(), ...imeisByKey.keys()]) {
      const [productId, location] = key.split("\u0001");
      if (productId === product.id) locations.add(location);
    }
    for (const location of locations) {
      const key = `${product.id}\u0001${location}`;
      if (product.requiresImei) {
        const firestore = [...new Set((map[location]?.imeis || []).map(cleanImei).filter(Boolean))].sort();
        const postgres = [...(imeisByKey.get(key) || [])].sort();
        if (firestore.join(",") !== postgres.join(",")) {
          differences.push({
            productId: product.id,
            name: product.name || "",
            location,
            onlyInFirestore: firestore.filter((imei) => !postgres.includes(imei)),
            onlyInPostgres: postgres.filter((imei) => !firestore.includes(imei)),
          });
        }
      } else {
        const firestore = Math.max(0, Math.round(Number(map[location]?.quantity) || 0));
        const postgres = qtyByKey.get(key) || 0;
        if (firestore !== postgres) {
          differences.push({ productId: product.id, name: product.name || "", location, firestore, postgres });
        }
      }
    }
  }
  return differences;
}

module.exports = {
  applyMovementsPg,
  buildSeed,
  ensureAverageCosts,
  stockValue,
  saleCosts,
  availableStock,
  commitOfficialStock,
  stockFieldsFor,
  compareInventory,
  costOf,
  ensureInventorySchema,
  isSeeded,
  readInventory,
  seedInventory,
};
