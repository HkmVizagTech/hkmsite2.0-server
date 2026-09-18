const { productModel, totalStock, priceRange } = require("../models/product.model");
const { shopCategoryModel } = require("../models/shopCategory.model");
const { getShopSettings, calculateShipping } = require("../models/shopSettings.model");
const { uploadToR2 } = require("../utils/r2");

const slugify = (raw) =>
  String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

// Slugs must be unique because they're the product's public URL. Rather
// than failing the admin's save with a duplicate-key error, quietly append
// -2, -3 … until it's free.
async function uniqueSlug(base, excludeId) {
  const root = slugify(base) || "item";
  let candidate = root;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = { slug: candidate };
    if (excludeId) query._id = { $ne: excludeId };
    const clash = await productModel.findOne(query).select("_id").lean();
    if (!clash) return candidate;
    n += 1;
    candidate = `${root}-${n}`;
  }
}

// What the storefront is allowed to see. Keeps the shaping in one place so
// the catalog list and the product page can never disagree about what
// "in stock" or "from ₹X" means.
function publicProductShape(product) {
  const range = priceRange(product);
  const stock = totalStock(product);
  return {
    _id: product._id,
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription,
    description: product.description,
    productInfo: product.productInfo || "",
    category: product.category,
    images: product.images || [],
    hasVariants: !!product.hasVariants,
    price: product.hasVariants ? undefined : product.price,
    mrp: product.hasVariants ? undefined : product.mrp,
    stock,
    priceMin: range.min,
    priceMax: range.max,
    inStock: stock > 0,
    featured: !!product.featured,
    freeShipping: !!product.freeShipping,
    tags: product.tags || [],
    weightGrams: product.weightGrams,
    variants: (product.variants || []).map((v) => ({
      _id: v._id,
      label: v.label,
      price: v.price,
      mrp: v.mrp,
      stock: v.stock,
      inStock: (Number(v.stock) || 0) > 0,
      weightGrams: v.weightGrams,
    })),
  };
}

const productController = {
  // ---------------------------------------------------------------------
  // PUBLIC (storefront)
  // ---------------------------------------------------------------------

  // GET /shop/products?category=&search=&sort=&page=&limit=
  // Only ever returns active products — a draft is the admin's work in
  // progress and must not be reachable by guessing a URL.
  listProducts: async (req, res) => {
    try {
      const { category, search, sort = "featured", page = 1, limit = 24, inStockOnly, ids } = req.query;
      const filter = { status: "active" };

      // ?ids=a,b,c — direct fetch by id for the "Saved for later" section.
      // Only well-formed ids make it into the query; anything else would
      // throw a Mongo cast error. Nothing valid at all → empty page.
      if (ids && String(ids).trim()) {
        const idList = String(ids)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-fA-F]{24}$/.test(s));
        if (idList.length === 0) {
          return res.status(200).json({
            success: true,
            products: [],
            pagination: { page: 1, limit: 0, total: 0, pages: 0 },
          });
        }
        filter._id = { $in: idList };
      }

      if (category && category !== "all") filter.category = category;
      if (search && String(search).trim()) {
        const term = String(search).trim();
        // Regex rather than $text so partial words ("agar") match too,
        // which is what a shopper typing into a search box expects.
        const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { shortDescription: rx }, { tags: rx }];
      }

      let sortSpec;
      switch (sort) {
        case "price-asc":
          sortSpec = { price: 1, createdAt: -1 };
          break;
        case "price-desc":
          sortSpec = { price: -1, createdAt: -1 };
          break;
        case "newest":
          sortSpec = { createdAt: -1 };
          break;
        default:
          sortSpec = { featured: -1, sortOrder: 1, createdAt: -1 };
      }

      const pageNum = Math.max(1, Number(page) || 1);
      const perPage = Math.min(60, Math.max(1, Number(limit) || 24));

      // "In stock only" must live in the Mongo filter (not a post-fetch
      // filter) so totals and page counts stay correct.
      if (String(inStockOnly) === "true") {
        filter.$and = [
          ...(filter.$and || []),
          {
            $or: [
              { hasVariants: false, stock: { $gt: 0 } },
              { hasVariants: true, "variants.stock": { $gt: 0 } },
            ],
          },
        ];
      }

      // Price sorts are finished in memory (variant prices live inside an
      // array, so Mongo can't sort on them) — which means ALL matching rows
      // must be fetched before the page is sliced. Slicing in Mongo first
      // made every page re-shuffle the same few rows, so items would
      // duplicate on one page and vanish from the next.
      const memoryPriceSort = sort === "price-asc" || sort === "price-desc";
      const baseQuery = productModel.find(filter).sort(sortSpec);
      if (memoryPriceSort) baseQuery.limit(200); // sane ceiling for a temple shop
      else baseQuery.skip((pageNum - 1) * perPage).limit(perPage);

      const [rows, total] = await Promise.all([
        baseQuery.lean(),
        productModel.countDocuments(filter),
      ]);

      let products = rows.map(publicProductShape);
      // Out-of-stock items stay visible (so a devotee can see the temple
      // stocks it at all) but always sort last — nobody wants a grid whose
      // first row can't be bought. The sorts below are stable, so the
      // chosen ordering is preserved inside each group.
      products.sort((a, b) => Number(b.inStock) - Number(a.inStock));

      // Variant products can't be sorted by price in Mongo (the price lives
      // inside the array), so price sorts are finished off in memory.
      if (sort === "price-asc") products.sort((a, b) => a.priceMin - b.priceMin);
      if (sort === "price-desc") products.sort((a, b) => b.priceMax - a.priceMax);

      if (memoryPriceSort) {
        products = products.slice((pageNum - 1) * perPage, pageNum * perPage);
      }

      res.status(200).json({
        success: true,
        products,
        pagination: { page: pageNum, limit: perPage, total, pages: Math.ceil(total / perPage) },
      });
    } catch (err) {
      console.error("product.listProducts error:", err);
      res.status(500).json({ success: false, message: "Could not load products." });
    }
  },

  // GET /shop/products/:slug
  getProduct: async (req, res) => {
    try {
      const product = await productModel.findOne({ slug: req.params.slug, status: "active" }).lean();
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });

      const related = await productModel
        .find({ status: "active", category: product.category, _id: { $ne: product._id } })
        .limit(4)
        .lean();

      res.status(200).json({
        success: true,
        product: publicProductShape(product),
        related: related.map(publicProductShape),
      });
    } catch (err) {
      console.error("product.getProduct error:", err);
      res.status(500).json({ success: false, message: "Could not load this product." });
    }
  },

  // GET /shop/categories — only categories that actually have something to
  // sell, with live counts for the filter chips.
  listCategories: async (req, res) => {
    try {
      const [categories, counts] = await Promise.all([
        shopCategoryModel.find({ status: "active" }).sort({ sortOrder: 1, name: 1 }).lean(),
        productModel.aggregate([
          { $match: { status: "active" } },
          { $group: { _id: "$category", count: { $sum: 1 } } },
        ]),
      ]);
      const countBySlug = new Map(counts.map((c) => [c._id, c.count]));
      res.status(200).json({
        success: true,
        categories: categories.map((c) => ({
          _id: c._id,
          name: c.name,
          slug: c.slug,
          description: c.description,
          image: c.image,
          productCount: countBySlug.get(c.slug) || 0,
        })),
      });
    } catch (err) {
      console.error("product.listCategories error:", err);
      res.status(500).json({ success: false, message: "Could not load categories." });
    }
  },

  // GET /shop/settings — the public slice only (shipping rules, delivery
  // estimate, whether the shop is open). Never returns internal fields.
  getPublicSettings: async (req, res) => {
    try {
      const settings = await getShopSettings();
      res.status(200).json({
        success: true,
        settings: {
          shopEnabled: settings.shopEnabled,
          flatShippingCharge: settings.flatShippingCharge,
          freeShippingAbove: settings.freeShippingAbove,
          announcement: settings.announcement,
          supportMobile: settings.supportMobile,
          deliveryEstimate: settings.deliveryEstimate,
        },
      });
    } catch (err) {
      console.error("product.getPublicSettings error:", err);
      res.status(500).json({ success: false, message: "Could not load shop settings." });
    }
  },

  // ---------------------------------------------------------------------
  // ADMIN
  // ---------------------------------------------------------------------

  // POST /shop-admin/upload-image — same R2 pattern as gallery/media.
  uploadImage: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const result = await uploadToR2(req.file.path, "shop");
      require("fs").unlink(req.file.path, () => {});
      res.status(200).json({ secure_url: result.secure_url });
    } catch (error) {
      console.error("product.uploadImage error:", error);
      res.status(500).json({ message: error.message || "Image upload failed" });
    }
  },

  // GET /shop-admin/products — every product including drafts, with the
  // raw fields the editor needs (not the public shape).
  adminListProducts: async (req, res) => {
    try {
      const { search, category, status } = req.query;
      const filter = {};
      if (category && category !== "all") filter.category = category;
      if (status && status !== "all") filter.status = status;
      if (search && String(search).trim()) {
        const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { slug: rx }, { tags: rx }];
      }
      const products = await productModel.find(filter).sort({ updatedAt: -1 }).lean();
      res.status(200).json({
        success: true,
        products: products.map((p) => ({ ...p, totalStock: totalStock(p) })),
      });
    } catch (err) {
      console.error("product.adminListProducts error:", err);
      res.status(500).json({ success: false, message: "Could not load products." });
    }
  },

  createProduct: async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ success: false, message: "Product name is required." });
      }

      const hasVariants = !!body.hasVariants;
      if (hasVariants) {
        if (!Array.isArray(body.variants) || body.variants.length === 0) {
          return res.status(400).json({ success: false, message: "Add at least one variant, or turn variants off." });
        }
        for (const v of body.variants) {
          if (!v.label || !String(v.label).trim()) {
            return res.status(400).json({ success: false, message: "Every variant needs a label (e.g. 100g)." });
          }
          if (typeof v.price !== "number" || v.price < 0) {
            return res.status(400).json({ success: false, message: `Enter a valid price for variant "${v.label}".` });
          }
        }
      } else if (typeof body.price !== "number" || body.price < 0) {
        return res.status(400).json({ success: false, message: "Enter a valid price." });
      }

      const product = await productModel.create({
        name: String(body.name).trim(),
        slug: await uniqueSlug(body.slug || body.name),
        shortDescription: body.shortDescription,
        description: body.description,
        productInfo: body.productInfo || "",
        category: body.category,
        images: Array.isArray(body.images) ? body.images.filter(Boolean) : [],
        hasVariants,
        price: hasVariants ? undefined : Number(body.price),
        mrp: hasVariants ? undefined : (body.mrp ? Number(body.mrp) : undefined),
        stock: hasVariants ? 0 : Number(body.stock) || 0,
        variants: hasVariants ? body.variants : [],
        weightGrams: body.weightGrams ? Number(body.weightGrams) : undefined,
        status: body.status === "active" ? "active" : "draft",
        featured: !!body.featured,
        freeShipping: !!body.freeShipping,
        tags: Array.isArray(body.tags) ? body.tags : [],
        sortOrder: Number(body.sortOrder) || 0,
        createdBy: req.user.userId,
      });

      res.status(201).json({ success: true, message: "Product created.", product });
    } catch (err) {
      console.error("product.createProduct error:", err);
      res.status(500).json({ success: false, message: err.message || "Could not create product." });
    }
  },

  updateProduct: async (req, res) => {
    try {
      const body = req.body || {};
      const existing = await productModel.findById(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: "Product not found." });

      const updates = {};
      if (body.name !== undefined) updates.name = String(body.name).trim();
      if (body.shortDescription !== undefined) updates.shortDescription = body.shortDescription;
      if (body.description !== undefined) updates.description = body.description;
      if (body.productInfo !== undefined) updates.productInfo = body.productInfo || "";
      if (body.category !== undefined) updates.category = body.category;
      if (body.images !== undefined) updates.images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
      if (body.weightGrams !== undefined) updates.weightGrams = body.weightGrams ? Number(body.weightGrams) : undefined;
      if (body.status !== undefined) updates.status = body.status === "active" ? "active" : "draft";
      if (body.featured !== undefined) updates.featured = !!body.featured;
      if (body.freeShipping !== undefined) updates.freeShipping = !!body.freeShipping;
      if (body.tags !== undefined) updates.tags = Array.isArray(body.tags) ? body.tags : [];
      if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder) || 0;
      // The slug is only regenerated on explicit request — silently changing
      // it when a name is edited would break every link already shared.
      if (body.regenerateSlug && body.name) {
        updates.slug = await uniqueSlug(body.name, existing._id);
      }

      if (body.hasVariants !== undefined) {
        updates.hasVariants = !!body.hasVariants;
        if (body.hasVariants) {
          if (!Array.isArray(body.variants) || body.variants.length === 0) {
            return res.status(400).json({ success: false, message: "Add at least one variant, or turn variants off." });
          }
          updates.variants = body.variants;
          updates.price = undefined;
          updates.mrp = undefined;
        } else {
          updates.variants = [];
          if (body.price !== undefined) updates.price = Number(body.price);
          if (body.mrp !== undefined) updates.mrp = body.mrp ? Number(body.mrp) : undefined;
          if (body.stock !== undefined) updates.stock = Number(body.stock) || 0;
        }
      } else {
        if (body.price !== undefined) updates.price = Number(body.price);
        if (body.mrp !== undefined) updates.mrp = body.mrp ? Number(body.mrp) : undefined;
        if (body.stock !== undefined) updates.stock = Number(body.stock) || 0;
        if (body.variants !== undefined) updates.variants = body.variants;
      }

      const product = await productModel.findByIdAndUpdate(existing._id, updates, { new: true });
      res.status(200).json({ success: true, message: "Product updated.", product });
    } catch (err) {
      console.error("product.updateProduct error:", err);
      res.status(500).json({ success: false, message: err.message || "Could not update product." });
    }
  },

  // PATCH /shop-admin/products/:id/stock — the quick "restocked 20 more"
  // action from the products table, kept separate from the full editor so
  // a stock correction can't accidentally overwrite the whole product.
  adjustStock: async (req, res) => {
    try {
      const { variantId, stock } = req.body || {};
      const newStock = Number(stock);
      if (!Number.isFinite(newStock) || newStock < 0) {
        return res.status(400).json({ success: false, message: "Enter a valid stock count." });
      }

      const product = await productModel.findById(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });

      if (product.hasVariants) {
        if (!variantId) return res.status(400).json({ success: false, message: "Choose which variant to restock." });
        const variant = product.variants.id(variantId);
        if (!variant) return res.status(404).json({ success: false, message: "Variant not found." });
        variant.stock = newStock;
      } else {
        product.stock = newStock;
      }
      await product.save();
      res.status(200).json({ success: true, message: "Stock updated.", product });
    } catch (err) {
      console.error("product.adjustStock error:", err);
      res.status(500).json({ success: false, message: "Could not update stock." });
    }
  },

  deleteProduct: async (req, res) => {
    try {
      const product = await productModel.findByIdAndDelete(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });
      // Past orders keep their own snapshot of this product (see
      // shopOrder.model.js), so deleting it here never corrupts order history.
      res.status(200).json({ success: true, message: "Product deleted." });
    } catch (err) {
      console.error("product.deleteProduct error:", err);
      res.status(500).json({ success: false, message: "Could not delete product." });
    }
  },

  // ---- Categories (admin) ----
  adminListCategories: async (req, res) => {
    try {
      const categories = await shopCategoryModel.find().sort({ sortOrder: 1, name: 1 }).lean();
      res.status(200).json({ success: true, categories });
    } catch (err) {
      console.error("product.adminListCategories error:", err);
      res.status(500).json({ success: false, message: "Could not load categories." });
    }
  },

  createCategory: async (req, res) => {
    try {
      const { name, description, image, sortOrder } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ success: false, message: "Category name is required." });
      }
      const slug = slugify(name);
      const clash = await shopCategoryModel.findOne({ slug }).lean();
      if (clash) return res.status(400).json({ success: false, message: "A category with that name already exists." });

      const category = await shopCategoryModel.create({
        name: String(name).trim(),
        slug,
        description,
        image,
        sortOrder: Number(sortOrder) || 0,
      });
      res.status(201).json({ success: true, message: "Category created.", category });
    } catch (err) {
      console.error("product.createCategory error:", err);
      res.status(500).json({ success: false, message: "Could not create category." });
    }
  },

  updateCategory: async (req, res) => {
    try {
      const updates = {};
      ["name", "description", "image", "status"].forEach((k) => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });
      if (req.body.sortOrder !== undefined) updates.sortOrder = Number(req.body.sortOrder) || 0;
      // The slug is intentionally NOT regenerated on rename: products point
      // at it, and quietly changing it would orphan every product in the
      // category.
      const category = await shopCategoryModel.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!category) return res.status(404).json({ success: false, message: "Category not found." });
      res.status(200).json({ success: true, message: "Category updated.", category });
    } catch (err) {
      console.error("product.updateCategory error:", err);
      res.status(500).json({ success: false, message: "Could not update category." });
    }
  },

  deleteCategory: async (req, res) => {
    try {
      const category = await shopCategoryModel.findById(req.params.id);
      if (!category) return res.status(404).json({ success: false, message: "Category not found." });
      const inUse = await productModel.countDocuments({ category: category.slug });
      if (inUse > 0) {
        return res.status(400).json({
          success: false,
          message: `${inUse} product${inUse > 1 ? "s are" : " is"} still in this category. Move them first, or hide the category instead.`,
        });
      }
      await shopCategoryModel.findByIdAndDelete(category._id);
      res.status(200).json({ success: true, message: "Category deleted." });
    } catch (err) {
      console.error("product.deleteCategory error:", err);
      res.status(500).json({ success: false, message: "Could not delete category." });
    }
  },

  // ---- Settings (admin) ----
  getAdminSettings: async (req, res) => {
    try {
      const settings = await getShopSettings();
      res.status(200).json({ success: true, settings });
    } catch (err) {
      console.error("product.getAdminSettings error:", err);
      res.status(500).json({ success: false, message: "Could not load settings." });
    }
  },

  updateSettings: async (req, res) => {
    try {
      const updates = { updatedBy: req.user.userId };
      if (req.body.shopEnabled !== undefined) updates.shopEnabled = !!req.body.shopEnabled;
      if (req.body.flatShippingCharge !== undefined) {
        const v = Number(req.body.flatShippingCharge);
        if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, message: "Enter a valid shipping charge." });
        updates.flatShippingCharge = v;
      }
      if (req.body.freeShippingAbove !== undefined) {
        const v = Number(req.body.freeShippingAbove);
        if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, message: "Enter a valid free-shipping threshold." });
        updates.freeShippingAbove = v;
      }
      ["announcement", "supportMobile", "deliveryEstimate"].forEach((k) => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });

      const { shopSettingsModel } = require("../models/shopSettings.model");
      const settings = await shopSettingsModel.findByIdAndUpdate("default", updates, { new: true, upsert: true });
      res.status(200).json({ success: true, message: "Shop settings saved.", settings });
    } catch (err) {
      console.error("product.updateSettings error:", err);
      res.status(500).json({ success: false, message: "Could not save settings." });
    }
  },
};

module.exports = { productController, publicProductShape, slugify, calculateShipping };
