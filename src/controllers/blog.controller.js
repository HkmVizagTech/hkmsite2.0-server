const { blogModel } = require("../models/blog.model");
const { uploadToCloudinary } = require("../utils/cloudinary");
const fs = require("fs");

// Generate a URL-friendly slug from title
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);

// Make sure the slug is unique; append -2, -3, ... if needed
const ensureUniqueSlug = async (base, excludeId) => {
  let slug = base || `post-${Date.now()}`;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };
    // eslint-disable-next-line no-await-in-loop
    const exists = await blogModel.findOne(query).lean();
    if (!exists) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
};

// Coerce tags coming in as JSON string OR comma-separated string OR array
const parseTags = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (s.startsWith("[")) {
    try { return JSON.parse(s).map((t) => String(t).trim()).filter(Boolean); } catch (_) {}
  }
  return s.split(",").map((t) => t.trim()).filter(Boolean);
};

const blogController = {
  // PUBLIC — list (published only by default; ?status=all for admin/listing in dashboard)
  list: async (req, res) => {
    try {
      const { status, category, tag, q, page = 1, limit = 12 } = req.query;
      const filter = {};
      if (status && status !== "all") filter.status = status;
      else if (!status) filter.status = "published";
      if (category) filter.category = category;
      if (tag) filter.tags = tag;
      if (q) filter.$text = { $search: q };

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
      const skip = (pageNum - 1) * lim;

      const [blogs, total] = await Promise.all([
        blogModel
          .find(filter)
          .sort({ publishedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(lim)
          .select("-content")
          .lean(),
        blogModel.countDocuments(filter),
      ]);

      res.status(200).json({
        blogs,
        page: pageNum,
        limit: lim,
        total,
        totalPages: Math.ceil(total / lim),
      });
    } catch (err) {
      console.error("Blog list error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // PUBLIC — get single by slug OR id (front-end may use either)
  get: async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const isObjectId = /^[a-f\d]{24}$/i.test(idOrSlug);
      const query = isObjectId ? { _id: idOrSlug } : { slug: idOrSlug };
      const blog = await blogModel.findOne(query);
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      // public should only see published; admins fetch with ?preview=1
      if (blog.status !== "published" && req.query.preview !== "1") {
        return res.status(404).json({ message: "Blog not found" });
      }
      // best-effort view counter (non-blocking)
      blogModel.updateOne({ _id: blog._id }, { $inc: { views: 1 } }).catch(() => {});
      res.status(200).json({ blog });
    } catch (err) {
      console.error("Blog get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // PUBLIC — related (same category, exclude self)
  related: async (req, res) => {
    try {
      const { id } = req.params;
      const current = await blogModel.findById(id).select("category").lean();
      if (!current) return res.status(404).json({ message: "Blog not found" });
      const items = await blogModel
        .find({ _id: { $ne: id }, status: "published", category: current.category })
        .sort({ publishedAt: -1 })
        .limit(4)
        .select("-content")
        .lean();
      res.status(200).json({ items });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — create
  create: async (req, res) => {
    try {
      const { title, excerpt, content, category, status, author, slug, metaTitle, metaDescription } = req.body;

      // Cover image upload
      let coverImage = req.body.coverImage || "";
      let extraImages = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          // eslint-disable-next-line no-await-in-loop
          const result = await uploadToCloudinary(file.path, "blogs");
          if (file.fieldname === "coverImage") coverImage = result.secure_url;
          else extraImages.push(result.secure_url);
          try { fs.unlinkSync(file.path); } catch (_) {}
        }
      }

      const baseSlug = slugify(slug || title);
      const uniqueSlug = await ensureUniqueSlug(baseSlug);

      const blog = await blogModel.create({
        title,
        slug: uniqueSlug,
        excerpt: excerpt || "",
        content,
        coverImage,
        images: extraImages,
        category: category || "General",
        tags: parseTags(req.body.tags),
        author: author || (req.user && req.user.name) || "Admin",
        status: status || "draft",
        metaTitle: metaTitle || "",
        metaDescription: metaDescription || excerpt || "",
        createdBy: req.user ? req.user.userId : undefined,
      });
      res.status(201).json({ message: "Blog created", blog });
    } catch (err) {
      console.error("Blog create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN — update
  update: async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await blogModel.findById(id);
      if (!existing) return res.status(404).json({ message: "Blog not found" });

      // Handle image uploads (cover + extras)
      let coverImage = req.body.coverImage !== undefined ? req.body.coverImage : existing.coverImage;
      let newExtras = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          // eslint-disable-next-line no-await-in-loop
          const result = await uploadToCloudinary(file.path, "blogs");
          if (file.fieldname === "coverImage") coverImage = result.secure_url;
          else newExtras.push(result.secure_url);
          try { fs.unlinkSync(file.path); } catch (_) {}
        }
      }

      // Update fields
      const patch = {
        title: req.body.title ?? existing.title,
        excerpt: req.body.excerpt ?? existing.excerpt,
        content: req.body.content ?? existing.content,
        category: req.body.category ?? existing.category,
        author: req.body.author ?? existing.author,
        status: req.body.status ?? existing.status,
        metaTitle: req.body.metaTitle ?? existing.metaTitle,
        metaDescription: req.body.metaDescription ?? existing.metaDescription,
        coverImage,
        images: newExtras.length ? [...(existing.images || []), ...newExtras] : existing.images,
      };
      if (req.body.tags !== undefined) patch.tags = parseTags(req.body.tags);

      // Handle slug change
      if (req.body.slug !== undefined && req.body.slug !== existing.slug) {
        const base = slugify(req.body.slug);
        patch.slug = await ensureUniqueSlug(base, id);
      } else if (req.body.title && req.body.title !== existing.title && !req.body.slug) {
        // Auto-bump slug only if it was auto-derived AND title meaningfully changed
        // (we keep slug stable on edits unless explicitly changed — safest)
      }

      // Apply and save to trigger readTime/publishedAt logic
      Object.assign(existing, patch);
      await existing.save();

      res.status(200).json({ message: "Blog updated", blog: existing });
    } catch (err) {
      console.error("Blog update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN — delete
  delete: async (req, res) => {
    try {
      const { id } = req.params;
      const blog = await blogModel.findByIdAndDelete(id);
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      res.status(200).json({ message: "Blog deleted" });
    } catch (err) {
      console.error("Blog delete error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN — generic image upload endpoint that CKEditor's SimpleUploadAdapter posts to.
  // Returns { url } shape that CKEditor expects.
  uploadInline: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: { message: "No file uploaded" } });
      const result = await uploadToCloudinary(req.file.path, "blogs/inline");
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      // CKEditor SimpleUpload response format:
      return res.status(200).json({ url: result.secure_url });
    } catch (err) {
      console.error("Blog inline upload error:", err);
      return res.status(500).json({ error: { message: err.message || "Upload failed" } });
    }
  },
};

module.exports = { blogController };
