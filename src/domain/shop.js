import { many } from "../db/pg.js";
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

async function getShopSettings() {
  let settings = await shopSettings.findById("default");
  if (!settings) {
    await shopSettings.insert({ _id: "default" }, { onConflictDoNothing: true });
    settings = await shopSettings.findById("default");
  }
  return settings;
}

const variantDoc = (row) => {
  const { productId, position, ...rest } = productVariants.fromRow(row);
  return rest;
};

// Attaches variants[] (ordered by position) to plain product documents.
async function attachVariants(docs, client) {
  if (!docs.length) return docs;
  const q = client ? client.query.bind(client) : null;
  const sql = "SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY product_id, position, id";
  const ids = docs.map((d) => d._id);
  const rows = q ? (await q(sql, [ids])).rows : await many(sql, [ids]);
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(variantDoc(row));
  }
  for (const d of docs) d.variants = byProduct.get(d._id) || [];
  return docs;
}

const orderItemDoc = (row) => {
  const { _id, orderId, ...rest } = shopOrderItems.fromRow(row);
  return rest;
};

// Attaches items[] (insertion order) to plain order documents.
async function attachItems(docs, client) {
  if (!docs.length) return docs;
  const sql = "SELECT * FROM shop_order_items WHERE order_id = ANY($1) ORDER BY order_id, id";
  const ids = docs.map((d) => d._id);
  const rows = client ? (await client.query(sql, [ids])).rows : await many(sql, [ids]);
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(orderItemDoc(row));
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

const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

export {
  resolvePurchasable,
  totalStock,
  priceRange,
  calculateShipping,
  getShopSettings,
  attachVariants,
  attachItems,
  insertOrderItems,
  escapeLike,
};
