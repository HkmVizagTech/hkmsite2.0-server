const mongoose = require("mongoose");

// Single-document settings for the shop. Pinned to a fixed _id ("default")
// so getSettings() can upsert it on first read and there is never a second
// row to disagree with the first.
const shopSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "default" },
    // Master switch — turns the storefront off (catalog visible, checkout
    // closed) for stock-taking or festival periods without deleting data.
    shopEnabled: { type: Boolean, default: true },
    // Flat shipping charge in rupees, waived once the cart subtotal reaches
    // freeShippingAbove.
    flatShippingCharge: { type: Number, default: 60 },
    freeShippingAbove: { type: Number, default: 1000 },
    announcement: { type: String, trim: true },
    supportMobile: { type: String, trim: true },
    // Shown on the product page / checkout so devotees know roughly when to
    // expect their order, without promising a hard date.
    deliveryEstimate: { type: String, default: "Usually dispatched in 3–5 working days" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false, _id: false }
);

const shopSettingsModel = mongoose.model("shopSettings", shopSettingsSchema);

// Always use this rather than querying the model directly — it guarantees
// a settings document exists, so every shipping calculation has real
// numbers to work with instead of undefined.
async function getShopSettings() {
  let settings = await shopSettingsModel.findById("default");
  if (!settings) {
    settings = await shopSettingsModel.create({ _id: "default" });
  }
  return settings;
}

// The single source of truth for shipping cost. Used by both the checkout
// API and the cart summary the customer sees, so the number quoted and the
// number charged can never drift apart.
function calculateShipping(subtotal, settings) {
  const flat = Number(settings?.flatShippingCharge) || 0;
  const freeAbove = Number(settings?.freeShippingAbove) || 0;
  if (freeAbove > 0 && subtotal >= freeAbove) return 0;
  return flat;
}

module.exports = { shopSettingsModel, getShopSettings, calculateShipping };
