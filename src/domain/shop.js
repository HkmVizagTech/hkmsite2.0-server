import { many, one } from "../db/pg.js";
import { productVariants, shopOrderItems, shopSettings } from "../db/tables.js";

function resolvePurchasable(product, variantId) {
  if (!product) return null;
  if (product.hasVariants) {
    if (!product.variants || product.variants.length === 0) return null;
    const variant = variantId ? product.variants.find((v) => String(v._id) === String(variantId)) : null;
    if (!variant) return null;
    return {
      price: variant.price,
      mrp: variant.mrp,
      stock: variant.stock,
      variantId: variant._id,
      variantLabel: variant.label,
      weightGrams: variant.weightGrams || product.weightGrams,
    };
  }
  if (typeof product.price !== "number") return null;
  return {
    price: product.price,
    mrp: product.mrp,
    stock: product.stock,
    variantId: null,
    variantLabel: null,
    weightGrams: product.weightGrams,
  };
}

function totalStock(product) {
  if (!product) return 0;
  if (product.hasVariants) return (product.variants || []).reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
  return Number(product.stock) || 0;
}

function priceRange(product) {
  if (!product) return { min: 0, max: 0 };
  if (product.hasVariants) {
    const prices = (product.variants || []).map((v) => Number(v.price) || 0);
    if (!prices.length) return { min: 0, max: 0 };
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }
  const p = Number(product.price) || 0;
  return { min: p, max: p };
}

function calculateShipping(subtotal, settings, items = []) {
  const flat = Number(settings?.flatShippingCharge) || 0;
  const freeAbove = Number(settings?.freeShippingAbove) || 0;
  const freeCount = items.filter((i) => i && i.freeShipping).length;
  if (items.length > 0 && freeCount === items.length) return 0;
  if (freeAbove > 0 && subtotal >= freeAbove) return 0;
  return flat;
}

// Mongoose keeps an explicit null on a defaulted field, while a NULL column reads back as the default. Such
// nulls are remembered in `extra` (e.g. extra.deliveryEstimate = null) and put back on hydrated documents.
const withNulls = (doc, row, keys) => {
  for (const k of keys) if (row?.extra && row.extra[k] === null) doc[k] = null;
  return doc;
};

const readSettings = async (client) => {
  const sql = "SELECT * FROM shop_settings WHERE id = 'default'";
  const row = client ? (await client.query(sql)).rows[0] : await one(sql);
  return row ? withNulls(shopSettings.fromRow(row), row, ["deliveryEstimate"]) : null;
};

async function getShopSettings() {
  let settings = await readSettings();
  if (!settings) {
    const now = new Date();
    await shopSettings.insert({ _id: "default", createdAt: now, updatedAt: now }, { onConflictDoNothing: true });
    settings = await readSettings();
  }
  return settings;
}

// Records or clears the explicit-null marker for `key` after a write that set it to `value`.
const setNullMarker = (table, id, key, value, client) =>
  client.query(
    value === null
      ? `UPDATE ${table} SET extra = jsonb_set(coalesce(extra, '{}'::jsonb), $2::text[], 'null'::jsonb) WHERE id = $1`
      : `UPDATE ${table} SET extra = NULLIF(extra - $2::text, '{}'::jsonb) WHERE id = $1 AND extra ? $2::text`,
    [id, value === null ? `{${key}}` : key]
  );

const variantDoc = (row, lean) => {
  const { productId, position, ...rest } = productVariants.fromRow(row, { lean });
  return rest;
};

// Attaches variants[] (ordered by position) to plain product documents. A variants value that cannot live in
// the child table (null, or an array holding null/scalars, written through an update) sits in extra.variants.
async function attachVariants(docs, client, { lean = false } = {}) {
  if (!docs.length) return docs;
  const run = (sql, params) => (client ? client.query(sql, params).then((r) => r.rows) : many(sql, params));
  const ids = docs.map((d) => d._id);
  const [rows, raw] = await Promise.all([
    run("SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY product_id, position", [ids]),
    run("SELECT id, extra->'variants' AS v FROM products WHERE id = ANY($1) AND extra ? 'variants'", [ids]),
  ]);
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(variantDoc(row, lean));
  }
  const rawById = new Map(raw.map((r) => [r.id, r.v]));
  for (const d of docs) d.variants = rawById.has(d._id) ? rawById.get(d._id) : byProduct.get(d._id) || [];
  return docs;
}

const orderItemDoc = (row, lean) => {
  const { _id, orderId, ...rest } = shopOrderItems.fromRow(row, { lean });
  return { variantId: null, variantLabel: null, ...rest };
};

// Attaches items[] (insertion order) to plain order documents.
async function attachItems(docs, client, { lean = false } = {}) {
  if (!docs.length) return docs;
  const sql = "SELECT * FROM shop_order_items WHERE order_id = ANY($1) ORDER BY order_id, id";
  const ids = docs.map((d) => d._id);
  const rows = client ? (await client.query(sql, [ids])).rows : await many(sql, [ids]);
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(orderItemDoc(row, lean));
  }
  for (const d of docs) d.items = byOrder.get(d._id) || [];
  return docs;
}

async function insertOrderItems(client, orderId, items) {
  for (const i of items) {
    await shopOrderItems.insert(
      {
        orderId,
        productId: i.productId,
        variantId: i.variantId || null,
        productName: i.productName,
        slug: i.slug,
        image: i.image,
        variantLabel: i.variantLabel || null,
        unitPrice: i.unitPrice,
        mrp: i.mrp,
        quantity: i.quantity,
        lineTotal: i.lineTotal,
        freeShipping: !!i.freeShipping,
      },
      { client }
    );
  }
}

// Mongo dates have millisecond precision, so ties are decided by insertion order (id), not by microseconds.
const ms = (col) => `date_trunc('milliseconds', ${col})`;

async function selectRows(repo, filter, orderSql, { limit, offset, lean = false, client } = {}) {
  const params = [];
  const where = repo.buildWhere(filter, params).sql;
  let sql = `SELECT * FROM ${repo.table}${where ? ` WHERE ${where}` : ""} ORDER BY ${orderSql}`;
  if (limit != null) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  if (offset) {
    params.push(offset);
    sql += ` OFFSET $${params.length}`;
  }
  const rows = client ? (await client.query(sql, params)).rows : await many(sql, params);
  return rows.map((r) => repo.fromRow(r, { lean }));
}

// Mongo skip/limit take whole numbers: fractions are truncated and absurd offsets simply return nothing.
const wholeNumber = (n) => Math.min(Math.trunc(n), 9e18);

// The old search was a case-insensitive Unicode regex in Mongo, whose folding does not depend on a database
// locale; run the same match here (JS `iu` folds like PCRE's UTF caseless mode) instead of ILIKE.
function searchMatcher(term) {
  if (term.includes("\0")) throw new Error("Regular expression cannot contain an embedded null byte");
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  return (texts) => texts.some((t) => typeof t === "string" && rx.test(t));
}

export {
  resolvePurchasable,
  totalStock,
  priceRange,
  calculateShipping,
  getShopSettings,
  attachVariants,
  attachItems,
  insertOrderItems,
  ms,
  selectRows,
  wholeNumber,
  searchMatcher,
  withNulls,
  readSettings,
  setNullMarker,
};
