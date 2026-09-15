const mongoose = require("mongoose");

// Shop categories are their own small collection rather than an enum on the
// product, so a shop admin can add "Tulsi Mala" or "Deity Dresses" without a
// code change. Products reference a category by its slug (see
// product.model.js), which is what the catalog's ?category= filter matches.
const shopCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true },
    image: { type: String },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "hidden"], default: "active" },
  },
  { timestamps: true, versionKey: false }
);

const shopCategoryModel = mongoose.model("shopCategory", shopCategorySchema);
module.exports = { shopCategoryModel };
