const mongoose = require("mongoose");

// One purchasable option of a product — "100g", "Pack of 3", "Medium".
// Each variant carries its OWN price and stock because that's the whole
// point of a variant: a 250g agarbatti pack is a different price and a
// different shelf count from the 100g one. Keeps its _id so an order line
// can point at exactly which option was bought, even if the label is later
// reworded.
const variantSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
    price: { type: Number, required: true, min: 0 },
    // Optional "was" price for the strike-through + % off badge. Only shown
    // when it's actually higher than price — a stale MRP equal to or below
    // the selling price renders no badge rather than a nonsense "0% off".
    mrp: { type: Number, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    weightGrams: { type: Number },
  },
  { _id: true, versionKey: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    // URL key for /shop/<slug>. Generated from the name on create and then
    // frozen — changing it would break any link a devotee has shared.
    slug: { type: String, required: true, unique: true, index: true },
    shortDescription: { type: String, trim: true },
    description: { type: String },
    // Stores the category's slug (see shopCategory.model.js), not its _id,
    // so the catalog can filter straight from a ?category= query string
    // without an extra lookup.
    category: { type: String, index: true },
    // R2 URLs. images[0] is the card/primary image; the rest fill the
    // product page gallery.
    images: { type: [String], default: [] },

    // ---- Pricing & stock ----
    // A product either has variants (each with its own price/stock) or it
    // doesn't (one price/stock on the product itself). Resolving code must
    // always go through the helpers below rather than reading these fields
    // directly, so the two shapes never get confused at checkout.
    hasVariants: { type: Boolean, default: false },
    price: { type: Number, min: 0 },
    mrp: { type: Number, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    variants: { type: [variantSchema], default: [] },

    weightGrams: { type: Number },
    status: { type: String, enum: ["active", "draft"], default: "draft", index: true },
    featured: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    // Manual ordering on the catalog; lower sorts first, ties fall back to
    // newest-first.
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

// Text index powers the catalog's search box.
productSchema.index({ name: "text", shortDescription: "text", tags: "text" });
productSchema.index({ status: 1, category: 1, sortOrder: 1 });

// ---------------------------------------------------------------------------
// Price/stock resolution helpers. Every checkout path uses these so a
// variant product and a simple product are handled identically and the
// server never trusts a price sent by the browser.
// ---------------------------------------------------------------------------

// Returns { price, mrp, stock, variantId, variantLabel } for the requested
// variant, or null if the product/variant combination isn't purchasable.
function resolvePurchasable(product, variantId) {
  if (!product) return null;
  if (product.hasVariants) {
    if (!product.variants || product.variants.length === 0) return null;
    const variant = variantId
      ? product.variants.find((v) => String(v._id) === String(variantId))
      : null;
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

// Total units on the shelf across every variant — what the catalog card's
// "In stock / Out of stock" badge is based on.
function totalStock(product) {
  if (!product) return 0;
  if (product.hasVariants) {
    return (product.variants || []).reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
  }
  return Number(product.stock) || 0;
}

// Lowest and highest sellable price, for the "₹80 – ₹330" range shown on a
// variant product's catalog card.
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

const productModel = mongoose.model("product", productSchema);
module.exports = { productModel, resolvePurchasable, totalStock, priceRange };
