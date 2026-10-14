import { unlink } from "node:fs";
import { many, one, tx, isId, newId } from "../db/pg.js";
import { products, shopCategories, shopSettings } from "../db/tables.js";
import {
  totalStock,
  priceRange,
  calculateShipping,
  getShopSettings,
  attachVariants,
  escapeLike,
} from "../domain/shop.js";
import { uploadToR2 } from "../utils/r2.js";

const slugify = (raw) =>
  String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

const trim = (v) => (typeof v === "string" ? v.trim() : v);

class BadRequest extends Error {}

const castError = (id, model) =>
  new Error(
    `Cast to ObjectId failed for value ${JSON.stringify(String(id))} (type string) at path "_id" for model "${model}"`
  );
const assertId = (id, model) => {
  if (!isId(id)) throw castError(id, model);
};

async function uniqueSlug(base, excludeId) {
  const root = slugify(base) || "item";
  let candidate = root;
  let n = 1;
  while (true) {
    const filter = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    const clash = await products.findOne(filter, { fields: ["_id"] });
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

const intOrNull = (v) => (v === undefined || v === null ? null : Math.round(Number(v)));

function validateVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new BadRequest("Add at least one variant, or turn variants off.");
  }
  for (const v of variants) {
    if (!v || !v.label || !String(v.label).trim()) throw new BadRequest("Every variant needs a label (e.g. 100g).");
    if (typeof v.price !== "number" || v.price < 0)
      throw new BadRequest(`Enter a valid price for variant "${v.label}".`);
    for (const k of ["mrp", "stock", "weightGrams"]) {
      if (v[k] !== undefined && v[k] !== null && (!Number.isFinite(Number(v[k])) || Number(v[k]) < 0)) {
        throw new BadRequest(`Enter a valid ${k} for variant "${v.label}".`);
      }
    }
  }
}

function money(value, message) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(message);
  return n;
}

// Replaces a product's variants, keeping the ids the client sent back for existing options
// (orders reference them) and dropping the rest.
async function syncVariants(client, productId, variants) {
  const existing = (
    await client.query("SELECT id, product_id FROM product_variants WHERE product_id = $1", [productId])
  ).rows;
  const own = new Set(existing.map((r) => r.id));
  const sentIds = variants.map((v) => (isId(String(v._id || "")) ? String(v._id) : null)).filter(Boolean);
  const taken = new Set(
    sentIds.length
      ? (await client.query("SELECT id FROM product_variants WHERE id = ANY($1)", [sentIds])).rows.map((r) => r.id)
      : []
  );
  const keep = new Set();
  const used = new Set();
  for (const [position, v] of variants.entries()) {
    const sent = isId(String(v._id || "")) ? String(v._id) : null;
    const reuse = sent && own.has(sent) && !used.has(sent);
    const id = reuse ? sent : sent && !taken.has(sent) && !used.has(sent) ? sent : newId();
    used.add(id);
    const row = {
      label: trim(v.label),
      sku: v.sku === undefined || v.sku === null ? null : trim(String(v.sku)),
      price: v.price,
      mrp: v.mrp === undefined || v.mrp === null ? null : Number(v.mrp),
      stock: v.stock === undefined || v.stock === null ? 0 : Math.round(Number(v.stock)),
      weightGrams: intOrNull(v.weightGrams),
      position,
    };
    if (reuse) {
      keep.add(id);
      await client.query(
        "UPDATE product_variants SET label=$2, sku=$3, price=$4, mrp=$5, stock=$6, weight_grams=$7, position=$8 WHERE id=$1",
        [id, row.label, row.sku, row.price, row.mrp, row.stock, row.weightGrams, row.position]
      );
    } else {
      await client.query(
        "INSERT INTO product_variants (id, product_id, label, sku, price, mrp, stock, weight_grams, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [id, productId, row.label, row.sku, row.price, row.mrp, row.stock, row.weightGrams, row.position]
      );
    }
  }
  const drop = [...own].filter((id) => !keep.has(id));
  if (drop.length) await client.query("DELETE FROM product_variants WHERE id = ANY($1)", [drop]);
}

async function loadProduct(id, client) {
  const doc = await products.findOne({ _id: id }, { client });
  if (!doc) return null;
  await attachVariants([doc], client);
  return doc;
}

const searchClause = (term, cols, tagsToo = true) => {
  const pattern = `%${escapeLike(term)}%`;
  const parts = cols.map((c) => `${c} ILIKE ?`);
  if (tagsToo) parts.push("EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE ?)");
  return { $raw: [`(${parts.join(" OR ")})`, new Array(parts.length).fill(pattern)] };
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

      if (category && category !== "all") filter.category = category;
      if (search && String(search).trim()) and.push(searchClause(String(search).trim(), ["name", "short_description"]));

      let orderSql;
      switch (sort) {
        case "price-asc":
          orderSql = "price ASC NULLS FIRST, created_at DESC, id";
          break;
        case "price-desc":
          orderSql = "price DESC NULLS LAST, created_at DESC, id";
          break;
        case "newest":
          orderSql = "created_at DESC, id";
          break;
        default:
          orderSql = "featured DESC, sort_order ASC, created_at DESC, id";
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
      let sql = `SELECT * FROM products WHERE ${where} ORDER BY ${orderSql}`;
      if (memoryPriceSort) sql += " LIMIT 200";
      else {
        params.push(perPage, (pageNum - 1) * perPage);
        sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
      }

      const [rows, total] = await Promise.all([many(sql, params), products.count(filter)]);
      const docs = await attachVariants(rows.map(products.fromRow));

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
      const product = await products.findOne({ slug: req.params.slug, status: "active" });
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });
      await attachVariants([product]);

      const related = await products.find(
        { status: "active", category: product.category ?? null, _id: { $ne: product._id } },
        { sort: { sortOrder: 1, createdAt: 1, _id: 1 }, limit: 4 }
      );
      await attachVariants(related);

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
        many(`SELECT * FROM shop_categories WHERE status = 'active' ORDER BY sort_order, name COLLATE "C", id`),
        many("SELECT category, count(*) AS n FROM products WHERE status = 'active' GROUP BY category"),
      ]);
      const countBySlug = new Map(counts.map((c) => [c.category, Number(c.n)]));
      res.status(200).json({
        success: true,
        categories: rows.map(shopCategories.fromRow).map((c) => ({
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
      if (category && category !== "all") filter.category = category;
      if (status && status !== "all") filter.status = status;
      if (search && String(search).trim()) filter.$and = [searchClause(String(search).trim(), ["name", "slug"])];
      const list = await products.find(filter, { sort: { updatedAt: -1, _id: 1 } });
      await attachVariants(list);
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
      if (hasVariants) validateVariants(body.variants);
      else if (typeof body.price !== "number" || body.price < 0) {
        return res.status(400).json({ success: false, message: "Enter a valid price." });
      }

      const doc = {
        name: String(body.name).trim(),
        slug: await uniqueSlug(body.slug || body.name),
        shortDescription: trim(body.shortDescription),
        description: body.description,
        productInfo: body.productInfo || "",
        category: body.category,
        images: Array.isArray(body.images) ? body.images.filter(Boolean).map(String) : [],
        hasVariants,
        price: hasVariants ? undefined : Number(body.price),
        mrp: hasVariants ? undefined : body.mrp ? money(body.mrp, "Enter a valid MRP.") : undefined,
        stock: hasVariants ? 0 : intOrNull(Number(body.stock) || 0),
        weightGrams: body.weightGrams ? intOrNull(money(body.weightGrams, "Enter a valid weight.")) : undefined,
        status: body.status === "active" ? "active" : "draft",
        featured: !!body.featured,
        freeShipping: !!body.freeShipping,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        sortOrder: intOrNull(Number(body.sortOrder) || 0),
        createdBy: req.user.userId,
      };
      if (doc.stock < 0) return res.status(400).json({ success: false, message: "Enter a valid stock count." });

      const product = await tx(async (client) => {
        const created = await products.insert(doc, { client });
        if (hasVariants) await syncVariants(client, created._id, body.variants);
        return loadProduct(created._id, client);
      });

      res.status(201).json({ success: true, message: "Product created.", product });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ success: false, message: err.message });
      console.error("product.createProduct error:", err);
      res.status(500).json({ success: false, message: err.message || "Could not create product." });
    }
  },

  updateProduct: async (req, res) => {
    try {
      const body = req.body || {};
      assertId(req.params.id, "product");
      const existing = await products.findById(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: "Product not found." });

      const updates = {};
      let variants;
      if (body.name !== undefined) updates.name = String(body.name).trim();
      if (body.shortDescription !== undefined) updates.shortDescription = trim(body.shortDescription);
      if (body.description !== undefined) updates.description = body.description;
      if (body.productInfo !== undefined) updates.productInfo = body.productInfo || "";
      if (body.category !== undefined) updates.category = body.category;
      if (body.images !== undefined)
        updates.images = Array.isArray(body.images) ? body.images.filter(Boolean).map(String) : [];
      if (body.weightGrams !== undefined && body.weightGrams) {
        updates.weightGrams = intOrNull(money(body.weightGrams, "Enter a valid weight."));
      }
      if (body.status !== undefined) updates.status = body.status === "active" ? "active" : "draft";
      if (body.featured !== undefined) updates.featured = !!body.featured;
      if (body.freeShipping !== undefined) updates.freeShipping = !!body.freeShipping;
      if (body.tags !== undefined) updates.tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      if (body.sortOrder !== undefined) updates.sortOrder = intOrNull(Number(body.sortOrder) || 0);
      if (body.regenerateSlug && body.name) {
        updates.slug = await uniqueSlug(body.name, existing._id);
      }

      const applyPricing = () => {
        if (body.price !== undefined) updates.price = money(body.price, "Enter a valid price.");
        if (body.mrp !== undefined && body.mrp) updates.mrp = money(body.mrp, "Enter a valid MRP.");
        if (body.stock !== undefined)
          updates.stock = intOrNull(money(Number(body.stock) || 0, "Enter a valid stock count."));
      };

      if (body.hasVariants !== undefined) {
        updates.hasVariants = !!body.hasVariants;
        if (body.hasVariants) {
          validateVariants(body.variants);
          variants = body.variants;
        } else {
          variants = [];
          applyPricing();
        }
      } else {
        applyPricing();
        if (body.variants !== undefined) {
          if (Array.isArray(body.variants) && body.variants.length) validateVariants(body.variants);
          variants = Array.isArray(body.variants) ? body.variants : [];
        }
      }

      const product = await tx(async (client) => {
        const locked = await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [existing._id]);
        if (!locked.rows.length) return null;
        await products.updateById(existing._id, updates, { client });
        if (variants !== undefined) await syncVariants(client, existing._id, variants);
        return loadProduct(existing._id, client);
      });
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });

      res.status(200).json({ success: true, message: "Product updated.", product });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ success: false, message: err.message });
      console.error("product.updateProduct error:", err);
      res.status(500).json({ success: false, message: err.message || "Could not update product." });
    }
  },

  adjustStock: async (req, res) => {
    try {
      const { variantId, stock } = req.body || {};
      const newStock = Number(stock);
      if (!Number.isFinite(newStock) || newStock < 0) {
        return res.status(400).json({ success: false, message: "Enter a valid stock count." });
      }
      assertId(req.params.id, "product");
      const value = Math.round(newStock);

      const result = await tx(async (client) => {
        const row = (
          await client.query("SELECT id, has_variants FROM products WHERE id = $1 FOR UPDATE", [req.params.id])
        ).rows[0];
        if (!row) return { status: 404, message: "Product not found." };
        if (row.has_variants) {
          if (!variantId) return { status: 400, message: "Choose which variant to restock." };
          const upd = isId(String(variantId))
            ? await client.query("UPDATE product_variants SET stock = $1 WHERE id = $2 AND product_id = $3", [
                value,
                String(variantId),
                row.id,
              ])
            : { rowCount: 0 };
          if (!upd.rowCount) return { status: 404, message: "Variant not found." };
          await client.query("UPDATE products SET updated_at = now() WHERE id = $1", [row.id]);
        } else {
          await client.query("UPDATE products SET stock = $1, updated_at = now() WHERE id = $2", [value, row.id]);
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
      assertId(req.params.id, "product");
      const product = await products.deleteById(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: "Product not found." });
      res.status(200).json({ success: true, message: "Product deleted." });
    } catch (err) {
      console.error("product.deleteProduct error:", err);
      res.status(500).json({ success: false, message: "Could not delete product." });
    }
  },

  adminListCategories: async (req, res) => {
    try {
      const rows = await many(`SELECT * FROM shop_categories ORDER BY sort_order, name COLLATE "C", id`);
      res.status(200).json({ success: true, categories: rows.map(shopCategories.fromRow) });
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
      const clash = await shopCategories.findOne({ slug });
      if (clash) return res.status(400).json({ success: false, message: "A category with that name already exists." });

      const category = await shopCategories.insert({
        name: String(name).trim(),
        slug,
        description: trim(description),
        image,
        sortOrder: intOrNull(Number(sortOrder) || 0),
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
        if (req.body[k] !== undefined)
          updates[k] = k === "name" || k === "description" ? trim(req.body[k]) : req.body[k];
      });
      if (updates.status !== undefined && !["active", "hidden"].includes(updates.status)) {
        return res.status(400).json({ success: false, message: "Status must be active or hidden." });
      }
      if (req.body.sortOrder !== undefined) updates.sortOrder = intOrNull(Number(req.body.sortOrder) || 0);
      assertId(req.params.id, "shopCategory");
      const category = await shopCategories.updateById(req.params.id, updates);
      if (!category) return res.status(404).json({ success: false, message: "Category not found." });
      res.status(200).json({ success: true, message: "Category updated.", category });
    } catch (err) {
      console.error("product.updateCategory error:", err);
      res.status(500).json({ success: false, message: "Could not update category." });
    }
  },

  deleteCategory: async (req, res) => {
    try {
      assertId(req.params.id, "shopCategory");
      const category = await shopCategories.findById(req.params.id);
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
        if (req.body[k] !== undefined) updates[k] = k === "deliveryEstimate" ? req.body[k] : trim(req.body[k]);
      });

      await getShopSettings();
      const settings = await shopSettings.updateById("default", updates);
      res.status(200).json({ success: true, message: "Shop settings saved.", settings });
    } catch (err) {
      console.error("product.updateSettings error:", err);
      res.status(500).json({ success: false, message: "Could not save settings." });
    }
  },
};

export { productController, publicProductShape, slugify, calculateShipping };
