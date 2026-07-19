const { blogModel, BLOG_CATEGORIES } = require("../models/blog.model");
const { uploadToR2 } = require("../utils/r2");
const fs = require("fs");

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);

const ensureUniqueSlug = async (base, excludeId) => {
  let slug = base || `post-${Date.now()}`;
  let n = 1;
  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await blogModel.findOne(query).lean();
    if (!exists) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
};

const parseTags = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (s.startsWith("[")) {
    try { return JSON.parse(s).map((t) => String(t).trim()).filter(Boolean); } catch (_) {}
  }
  return s.split(",").map((t) => t.trim()).filter(Boolean);
};

// Build author object from form fields
const buildAuthor = (body, req) => {
  // Support both flat fields and a JSON author object
  let author = {};
  if (body.author && typeof body.author === "string" && body.author.startsWith("{")) {
    try { author = JSON.parse(body.author); } catch (_) {}
  }
  return {
    name: body.authorName || author.name || body.author || (req.user && req.user.name) || "Admin",
    avatar: body.authorAvatar || author.avatar || "",
    bio: body.authorBio || author.bio || "",
    slug: body.authorSlug || author.slug || slugify(body.authorName || author.name || "admin"),
  };
};

const blogController = {
  // PUBLIC - list (published only by default)
  list: async (req, res) => {
    try {
      const { status, category, tag, q, featured, page = 1, limit = 12 } = req.query;
      const filter = {};
      if (status && status !== "all") filter.status = status;
      else if (!status) filter.status = "published";
      if (category) filter.category = category;
      if (tag) filter.tags = tag;
      if (featured === "true") filter.featured = true;
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

  // PUBLIC - landing data for /blogs (GVD-style multi-section page)
  // Returns: recents, devotionalWisdom, byCategory[], popular, recent
  // Saves the client from making 8 separate requests.
  landing: async (req, res) => {
    try {
      const base = { status: "published" };

      // Recent posts (top 5) for hero strip
      const recents = await blogModel
        .find(base)
        .sort({ publishedAt: -1 })
        .limit(5)
        .select("-content")
        .lean();

      // Devotional Wisdom carousel - latest one per several categories
      const devotional = await blogModel
        .find(base)
        .sort({ publishedAt: -1 })
        .limit(5)
        .select("-content")
        .lean();

      // Category counts for the "Get Started Here" 13-tile grid
      const counts = await blogModel.aggregate([
        { $match: base },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]);
      const countMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));
      const categories = BLOG_CATEGORIES.map((name) => ({
        name,
        slug: slugify(name),
        count: countMap[name] || 0,
      }));

      // Per-category latest 6 - GVD shows a section for each populated category
      const populatedCategories = categories.filter((c) => c.count > 0).slice(0, 6);
      const byCategory = await Promise.all(
        populatedCategories.map(async (cat) => {
          const items = await blogModel
            .find({ ...base, category: cat.name })
            .sort({ publishedAt: -1 })
            .limit(6)
            .select("-content")
            .lean();
          return { ...cat, items };
        })
      );

      // Popular - featured flag, fallback to most-viewed
      let popular = await blogModel
        .find({ ...base, featured: true })
        .sort({ publishedAt: -1 })
        .limit(6)
        .select("-content")
        .lean();
      if (popular.length < 6) {
        const fill = await blogModel
          .find(base)
          .sort({ views: -1, publishedAt: -1 })
          .limit(6 - popular.length)
          .select("-content")
          .lean();
        const have = new Set(popular.map((p) => String(p._id)));
        popular = [...popular, ...fill.filter((f) => !have.has(String(f._id)))];
      }

      // Most recent 7 - rich detailed cards near the bottom of the page
      const recent = await blogModel
        .find(base)
        .sort({ publishedAt: -1 })
        .limit(7)
        .select("-content")
        .lean();

      res.status(200).json({
        recents,
        devotional,
        categories,
        byCategory,
        popular,
        recent,
      });
    } catch (err) {
      console.error("Blog landing error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // PUBLIC - list of categories with counts (for category navigation)
  categories: async (req, res) => {
    try {
      const counts = await blogModel.aggregate([
        { $match: { status: "published" } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]);
      const countMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));
      const categories = BLOG_CATEGORIES.map((name) => ({
        name,
        slug: slugify(name),
        count: countMap[name] || 0,
      }));
      res.status(200).json({ categories });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  // PUBLIC - get one by slug or id
  get: async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const isObjectId = /^[a-f\d]{24}$/i.test(idOrSlug);
      const query = isObjectId ? { _id: idOrSlug } : { slug: idOrSlug };
      const blog = await blogModel.findOne(query);
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      if (blog.status !== "published" && req.query.preview !== "1") {
        return res.status(404).json({ message: "Blog not found" });
      }
      blogModel.updateOne({ _id: blog._id }, { $inc: { views: 1 } }).catch(() => {});
      res.status(200).json({ blog });
    } catch (err) {
      console.error("Blog get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // PUBLIC - related blogs (same category, exclude self)
  related: async (req, res) => {
    try {
      const { id } = req.params;
      const current = await blogModel.findById(id).select("category").lean();
      if (!current) return res.status(404).json({ message: "Blog not found" });
      const items = await blogModel
        .find({ _id: { $ne: id }, status: "published", category: current.category })
        .sort({ publishedAt: -1 })
        .limit(5)
        .select("-content")
        .lean();
      res.status(200).json({ items });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN - create
  create: async (req, res) => {
    try {
      const { title, excerpt, content, category, status, slug, metaTitle, metaDescription, featured } = req.body;

      let coverImage = req.body.coverImage || "";
      let authorAvatar = req.body.authorAvatar || "";
      let extraImages = [];

      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const result = await uploadToR2(file.path, "blogs");
          if (file.fieldname === "coverImage") coverImage = result.secure_url;
          else if (file.fieldname === "authorAvatar") authorAvatar = result.secure_url;
          else extraImages.push(result.secure_url);
          try { fs.unlinkSync(file.path); } catch (_) {}
        }
      }

      const baseSlug = slugify(slug || title);
      const uniqueSlug = await ensureUniqueSlug(baseSlug);

      const author = buildAuthor({ ...req.body, authorAvatar }, req);

      const blog = await blogModel.create({
        title,
        slug: uniqueSlug,
        excerpt: excerpt || "",
        content,
        coverImage,
        images: extraImages,
        category: category || "Spiritual Knowledge",
        tags: parseTags(req.body.tags),
        author,
        status: status || "draft",
        featured: featured === "true" || featured === true,
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

  // ADMIN - update
  update: async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await blogModel.findById(id);
      if (!existing) return res.status(404).json({ message: "Blog not found" });

      let coverImage = req.body.coverImage !== undefined ? req.body.coverImage : existing.coverImage;
      let authorAvatar = req.body.authorAvatar !== undefined ? req.body.authorAvatar : (existing.author && existing.author.avatar) || "";
      let newExtras = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const result = await uploadToR2(file.path, "blogs");
          if (file.fieldname === "coverImage") coverImage = result.secure_url;
          else if (file.fieldname === "authorAvatar") authorAvatar = result.secure_url;
          else newExtras.push(result.secure_url);
          try { fs.unlinkSync(file.path); } catch (_) {}
        }
      }

      const author = buildAuthor({ ...req.body, authorAvatar }, req);

      const patch = {
        title: req.body.title ?? existing.title,
        excerpt: req.body.excerpt ?? existing.excerpt,
        content: req.body.content ?? existing.content,
        category: req.body.category ?? existing.category,
        author,
        status: req.body.status ?? existing.status,
        metaTitle: req.body.metaTitle ?? existing.metaTitle,
        metaDescription: req.body.metaDescription ?? existing.metaDescription,
        coverImage,
        images: newExtras.length ? [...(existing.images || []), ...newExtras] : existing.images,
      };
      if (req.body.tags !== undefined) patch.tags = parseTags(req.body.tags);
      if (req.body.featured !== undefined) {
        patch.featured = req.body.featured === "true" || req.body.featured === true;
      }

      if (req.body.slug !== undefined && req.body.slug !== existing.slug) {
        const base = slugify(req.body.slug);
        patch.slug = await ensureUniqueSlug(base, id);
      }

      Object.assign(existing, patch);
      await existing.save();

      res.status(200).json({ message: "Blog updated", blog: existing });
    } catch (err) {
      console.error("Blog update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // A full admin deletes immediately, as before. A blogs_admin's call here
  // instead files a pending deletion request - the post stays live and
  // untouched until an admin approves or rejects it via the endpoints below.
  delete: async (req, res) => {
    try {
      const { id } = req.params;

      if (req.user.role === "blogs_admin") {
        const blog = await blogModel.findByIdAndUpdate(
          id,
          {
            deletionRequested: true,
            deletionRequestedBy: req.user.userId,
            deletionRequestedAt: new Date(),
          },
          { new: true }
        );
        if (!blog) return res.status(404).json({ message: "Blog not found" });
        return res.status(200).json({
          message: "Deletion requested — an admin needs to approve this before it's removed.",
          blog,
        });
      }

      const blog = await blogModel.findByIdAndDelete(id);
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      res.status(200).json({ message: "Blog deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN ONLY - list posts with a pending deletion request
  deletionRequests: async (req, res) => {
    try {
      const blogs = await blogModel
        .find({ deletionRequested: true })
        .sort({ deletionRequestedAt: -1 })
        .populate("deletionRequestedBy", "name email")
        .select("title slug category coverImage deletionRequestedBy deletionRequestedAt");
      res.status(200).json({ blogs });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN ONLY - approve a pending deletion request: actually deletes the post
  approveDeletion: async (req, res) => {
    try {
      const { id } = req.params;
      const blog = await blogModel.findOne({ _id: id, deletionRequested: true });
      if (!blog) return res.status(404).json({ message: "No pending deletion request for this post" });
      await blogModel.findByIdAndDelete(id);
      res.status(200).json({ message: "Deletion approved — post removed" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN ONLY - reject a pending deletion request: post stays, flag cleared
  rejectDeletion: async (req, res) => {
    try {
      const { id } = req.params;
      const blog = await blogModel.findByIdAndUpdate(
        id,
        { deletionRequested: false, deletionRequestedBy: null, deletionRequestedAt: null },
        { new: true }
      );
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      res.status(200).json({ message: "Deletion request rejected — post kept", blog });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // CKEditor inline image upload
  uploadInline: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: { message: "No file uploaded" } });
      const result = await uploadToR2(req.file.path, "blogs/inline");
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(200).json({ url: result.secure_url });
    } catch (err) {
      console.error("Blog inline upload error:", err);
      return res.status(500).json({ error: { message: err.message || "Upload failed" } });
    }
  },
};

module.exports = { blogController };
