import { unlink } from "node:fs";
import { many, tx } from "../db/pg.js";
import { products, shopCategories, shopSettings } from "../db/tables.js";
import {
  totalStock,
  priceRange,
  calculateShipping,
  getShopSettings,
  attachVariants,
  ms,
  selectRows,
  wholeNumber,
  searchMatcher,
  withNulls,
  readSettings,
  setNullMarker,
} from "../domain/shop.js";
import {
  PRODUCT,
  CATEGORY,
  SETTINGS,
  buildDocument,
  castUpdate,
  castIdParam,
  looseObjectId,
  queryValue,
} from "../domain/shopSchema.js";
import { uploadToR2 } from "../utils/r2.js";

const slugify = (raw) =>
  String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

async function uniqueSlug(base, excludeId) {
  const root = slugify(base) || "item";
  let candidate = root;
  let n = 1;
  while (true) {
    const filter = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    const clash = await products.findOne(filter, { fields: ["_id"], lean: true });
    if (!clash) return candidate;
    n += 1;
    candidate = `${root}-${n}`;
  }
}

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

// Replaces a product's variants wholesale, like assigning the embedded array did.
async function replaceVariants(client, productId, variants) {
  await client.query("DELETE FROM product_variants WHERE product_id = $1", [productId]);
  const clean = Array.isArray(variants) && variants.every((v) => v && typeof v === "object" && !Array.isArray(v));
  if (variants == null || !clean) {
    await client.query(
      "UPDATE products SET extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{variants}', $2::jsonb) WHERE id = $1",
      [productId, JSON.stringify(variants ?? null)]
    );
    return;
  }
  await client.query("UPDATE products SET extra = NULLIF(extra - 'variants', '{}'::jsonb) WHERE id = $1 AND extra ? 'variants'", [
    productId,
  ]);
  for (const [position, v] of variants.entries()) {
    await client.query(
      "INSERT INTO product_variants (id, product_id, label, sku, price, mrp, stock, weight_grams, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [v._id, productId, v.label ?? null, v.sku ?? null, v.price ?? null, v.mrp ?? null, v.stock ?? null, v.weightGrams ?? null, position]
    );
  }
}

// Variants are always read raw: an explicit null stock must not turn into the column default.
async function loadProduct(id, client, { lean = false } = {}) {
  const doc = await products.findOne({ _id: id }, { client, lean });
  if (!doc) return null;
  await attachVariants([doc], client, { lean: true });
  return doc;
}

const stamp = () => {
  const now = new Date();
  return { createdAt: now, updatedAt: now };
};

const productController = {
  listProducts: async (req, res) => {
    try {
      const { category, search, sort = "featured", page = 1, limit = 24, inStockOnly, ids } = req.query;
      const filter = { status: "active" };
      const and = [];

      if (ids && String(ids).trim()) {
        const idList = String(ids)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-fA-F]{24}$/.test(s))
          .map((s) => s.toLowerCase());
        if (idList.length === 0) {
          return res.status(200).json({
            success: true,
            products: [],
            pagination: { page: 1, limit: 0, total: 0, pages: 0 },
          });
        }
        filter._id = { $in: idList };
      }

      if (category && category !== "all") filter.category = queryValue(category, "category", "product");
      const matcher = search && String(search).trim() ? searchMatcher(String(search).trim()) : null;

      let orderSql;
      switch (sort) {
        case "price-asc":
          orderSql = `price ASC NULLS FIRST, ${ms("created_at")} DESC, id`;
          break;
        case "price-desc":
          orderSql = `price DESC NULLS LAST, ${ms("created_at")} DESC, id`;
          break;
        case "newest":
          orderSql = `${ms("created_at")} DESC, id`;
          break;
        default:
          orderSql = `featured DESC NULLS LAST, sort_order ASC NULLS FIRST, ${ms("created_at")} DESC, id`;
      }

      const pageNum = Math.max(1, Number(page) || 1);
      const perPage = Math.min(60, Math.max(1, Number(limit) || 24));

      if (String(inStockOnly) === "true") {
        and.push({
          $raw: [
            "((has_variants = false AND stock > 0) OR (has_variants = true AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND pv.stock > 0)))",
            [],
          ],
        });
      }
      if (and.length) filter.$and = and;

      const memoryPriceSort = sort === "price-asc" || sort === "price-desc";
      const params = [];
      const where = products.buildWhere(filter, params).sql;
      let sql = `SELECT * FROM products WHERE ${where || "TRUE"} ORDER BY ${orderSql}`;
      const skip = wholeNumber((pageNum - 1) * perPage);
      if (!matcher) {
        if (memoryPriceSort) sql += " LIMIT 200";
        else {
          params.push(wholeNumber(perPage), skip);
          sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
        }
      }

      let [rows, total] = await Promise.all([many(sql, params), matcher ? null : products.count(filter)]);
      if (matcher) {
        rows = rows.filter((r) => matcher([r.name, r.short_description, ...(r.tags || [])]));
        total = rows.length;
        rows = memoryPriceSort ? rows.slice(0, 200) : rows.slice(skip, skip + wholeNumber(perPage));
      }
      const docs = await attachVariants(
        rows.map((r) => products.fromRow(r, { lean: true })),
        undefined,
        { lean: true }
      );

      let list = docs.map(publicProductShape);
      list.sort((a, b) => Number(b.inStock) - Number(a.inStock));
      if (sort === "price-asc") list.sort((a, b) => a.priceMin - b.priceMin);
      if (sort === "price-desc") list.sort((a, b) => b.priceMax - a.priceMax);
      if (memoryPriceSort) list = list.slice((pageNum - 1) * perPage, pageNum * perPage);

      res.status(200).json({
        success: true,
        products: list,
        pagination: { page: pageNum, limit: perPage, total, pages: Math.ceil(total / perPage) },
      });
    } catch (err) {
      console.error("product.listProducts error:", err);
      res.status(500).json({ success: false, message: "Could not load products." });
    }
  },

  getProduct: async (req, res) => {
    try {
      const product = req.params.slug.includes("\0")
        ? null
        : await products.findOne({ slug: req.params.slug, status: "active" }, { lean: true });
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });
      await attachVariants([product], undefined, { lean: true });

      const related = await selectRows(
        products,
        { status: "active", category: product.category ?? null, _id: { $ne: product._id } },
        `sort_order NULLS FIRST, ${ms("created_at")}, id`,
        { limit: 4, lean: true }
      );
      await attachVariants(related, undefined, { lean: true });

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

  listCategories: async (req, res) => {
    try {
      const [rows, counts] = await Promise.all([
        many(`SELECT * FROM shop_categories WHERE status = 'active' ORDER BY sort_order NULLS FIRST, name COLLATE "C" NULLS FIRST, id`),
        many("SELECT category, count(*) AS n FROM products WHERE status = 'active' GROUP BY category"),
      ]);
      const countBySlug = new Map(counts.map((c) => [c.category, Number(c.n)]));
      res.status(200).json({
        success: true,
        categories: rows
          .map((r) => shopCategories.fromRow(r, { lean: true }))
          .map((c) => ({
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

  uploadImage: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const result = await uploadToR2(req.file.path, "shop");
      unlink(req.file.path, () => {});
      res.status(200).json({ secure_url: result.secure_url });
    } catch (error) {
      console.error("product.uploadImage error:", error);
      res.status(500).json({ message: error.message || "Image upload failed" });
    }
  },

  adminListProducts: async (req, res) => {
    try {
      const { search, category, status } = req.query;
      const filter = {};
      if (category && category !== "all") filter.category = queryValue(category, "category", "product");
      if (status && status !== "all") filter.status = queryValue(status, "status", "product");
      const matcher = search && String(search).trim() ? searchMatcher(String(search).trim()) : null;
      let list = await selectRows(products, filter, `${ms("updated_at")} DESC, id`, { lean: true });
      if (matcher) list = list.filter((p) => matcher([p.name, p.slug, ...(p.tags || [])]));
      await attachVariants(list, undefined, { lean: true });
      res.status(200).json({
        success: true,
        products: list.map((p) => ({ ...p, totalStock: totalStock(p) })),
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

      const { variants, ...doc } = buildDocument(PRODUCT, {
        name: String(body.name).trim(),
        slug: await uniqueSlug(body.slug || body.name),
        shortDescription: body.shortDescription,
        description: body.description,
        productInfo: body.productInfo || "",
        category: body.category,
        images: Array.isArray(body.images) ? body.images.filter(Boolean) : [],
        hasVariants,
        price: hasVariants ? undefined : Number(body.price),
        mrp: hasVariants ? undefined : body.mrp ? Number(body.mrp) : undefined,
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

      const product = await tx(async (client) => {
        const created = await products.insert({ ...doc, ...stamp() }, { client });
        await replaceVariants(client, created._id, variants);
        return loadProduct(created._id, client);
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
      const id = castIdParam(req.params.id, "product");
      const existing = await products.findById(id);
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

      const { variants, ...set } = castUpdate(PRODUCT, updates);
      const product = await tx(async (client) => {
        const locked = await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [existing._id]);
        if (!locked.rows.length) return null;
        await products.updateById(existing._id, { ...set, updatedAt: new Date() }, { client });
        if (variants !== undefined) await replaceVariants(client, existing._id, variants);
        return loadProduct(existing._id, client);
      });

      res.status(200).json({ success: true, message: "Product updated.", product });
    } catch (err) {
      console.error("product.updateProduct error:", err);
      res.status(500).json({ success: false, message: err.message || "Could not update product." });
    }
  },

  // Like Mongoose's save(): a value equal to the stored one is a no-op (updatedAt does not move).
  adjustStock: async (req, res) => {
    try {
      const { variantId, stock } = req.body || {};
      const newStock = Number(stock);
      if (!Number.isFinite(newStock) || newStock < 0) {
        return res.status(400).json({ success: false, message: "Enter a valid stock count." });
      }
      const id = castIdParam(req.params.id, "product");

      const result = await tx(async (client) => {
        const row = (await client.query("SELECT id, has_variants, stock FROM products WHERE id = $1 FOR UPDATE", [id]))
          .rows[0];
        if (!row) return { status: 404, message: "Product not found." };
        if (row.has_variants) {
          if (!variantId) return { status: 400, message: "Choose which variant to restock." };
          const wanted = looseObjectId(variantId);
          const variants = (
            await client.query("SELECT position, id, stock FROM product_variants WHERE product_id = $1 ORDER BY position", [row.id])
          ).rows;
          const variant = wanted ? variants.find((v) => v.id === wanted) : null;
          if (!variant) return { status: 404, message: "Variant not found." };
          if ((variant.stock ?? 0) !== newStock) {
            await client.query("UPDATE product_variants SET stock = $1 WHERE product_id = $2 AND position = $3", [
              newStock,
              row.id,
              variant.position,
            ]);
            await client.query("UPDATE products SET updated_at = $2 WHERE id = $1", [row.id, new Date()]);
          }
        } else if ((row.stock ?? 0) !== newStock) {
          await client.query("UPDATE products SET stock = $1, updated_at = $3 WHERE id = $2", [newStock, row.id, new Date()]);
        }
        return { product: await loadProduct(row.id, client) };
      });

      if (result.status) return res.status(result.status).json({ success: false, message: result.message });
      res.status(200).json({ success: true, message: "Stock updated.", product: result.product });
    } catch (err) {
      console.error("product.adjustStock error:", err);
      res.status(500).json({ success: false, message: "Could not update stock." });
    }
  },

  deleteProduct: async (req, res) => {
    try {
      const id = castIdParam(req.params.id, "product");
      const product = await tx(async (client) => {
        const deleted = await products.deleteById(id, { client });
        if (deleted) await client.query("DELETE FROM product_variants WHERE product_id = $1", [id]);
        return deleted;
      });
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });
      res.status(200).json({ success: true, message: "Product deleted." });
    } catch (err) {
      console.error("product.deleteProduct error:", err);
      res.status(500).json({ success: false, message: "Could not delete product." });
    }
  },

  adminListCategories: async (req, res) => {
    try {
      const rows = await many(`SELECT * FROM shop_categories ORDER BY sort_order NULLS FIRST, name COLLATE "C" NULLS FIRST, id`);
      res.status(200).json({ success: true, categories: rows.map((r) => shopCategories.fromRow(r, { lean: true })) });
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
      const clash = await shopCategories.findOne({ slug }, { lean: true });
      if (clash) return res.status(400).json({ success: false, message: "A category with that name already exists." });

      const doc = buildDocument(CATEGORY, {
        name: String(name).trim(),
        slug,
        description,
        image,
        sortOrder: Number(sortOrder) || 0,
      });
      const category = await shopCategories.insert({ ...doc, ...stamp() });
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
      const set = castUpdate(CATEGORY, updates);
      const id = castIdParam(req.params.id, "shopCategory");
      const category = await tx(async (client) => {
        const updated = await shopCategories.updateById(id, { ...set, updatedAt: new Date() }, { client });
        if (!updated) return null;
        if ("status" in set) await setNullMarker("shop_categories", id, "status", set.status, client);
        const row = (await client.query("SELECT * FROM shop_categories WHERE id = $1", [id])).rows[0];
        return withNulls(shopCategories.fromRow(row), row, ["status"]);
      });
      if (!category) return res.status(404).json({ success: false, message: "Category not found." });
      res.status(200).json({ success: true, message: "Category updated.", category });
    } catch (err) {
      console.error("product.updateCategory error:", err);
      res.status(500).json({ success: false, message: "Could not update category." });
    }
  },

  deleteCategory: async (req, res) => {
    try {
      const category = await shopCategories.findById(castIdParam(req.params.id, "shopCategory"));
      if (!category) return res.status(404).json({ success: false, message: "Category not found." });
      const inUse = await products.count({ category: category.slug });
      if (inUse > 0) {
        return res.status(400).json({
          success: false,
          message: `${inUse} product${inUse > 1 ? "s are" : " is"} still in this category. Move them first, or hide the category instead.`,
        });
      }
      await shopCategories.deleteById(category._id);
      res.status(200).json({ success: true, message: "Category deleted." });
    } catch (err) {
      console.error("product.deleteCategory error:", err);
      res.status(500).json({ success: false, message: "Could not delete category." });
    }
  },

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
        if (!Number.isFinite(v) || v < 0)
          return res.status(400).json({ success: false, message: "Enter a valid shipping charge." });
        updates.flatShippingCharge = v;
      }
      if (req.body.freeShippingAbove !== undefined) {
        const v = Number(req.body.freeShippingAbove);
        if (!Number.isFinite(v) || v < 0)
          return res.status(400).json({ success: false, message: "Enter a valid free-shipping threshold." });
        updates.freeShippingAbove = v;
      }
      ["announcement", "supportMobile", "deliveryEstimate"].forEach((k) => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });

      const set = castUpdate(SETTINGS, updates);
      await getShopSettings();
      const settings = await tx(async (client) => {
        await shopSettings.updateById("default", { ...set, updatedAt: new Date() }, { client });
        if ("deliveryEstimate" in set) await setNullMarker("shop_settings", "default", "deliveryEstimate", set.deliveryEstimate, client);
        return readSettings(client);
      });
      res.status(200).json({ success: true, message: "Shop settings saved.", settings });
    } catch (err) {
      console.error("product.updateSettings error:", err);
      res.status(500).json({ success: false, message: "Could not save settings." });
    }
  },
};

export { productController, publicProductShape, slugify, calculateShipping };
