import fs from "node:fs";
import { blogs } from "../db/tables.js";
import { query, many } from "../db/pg.js";
import { uploadToR2 } from "../utils/r2.js";
import { BLOG_CATEGORIES, sanitizeBlogHtml, computeReadTime } from "../domain/blog.js";
import { blogSchema } from "../domain/schemas.js";
import { makeStore, castQueryId, queryEq, stripNulls } from "../domain/store.js";
import { textSearchIds } from "../domain/blogSearch.js";

const store = makeStore(blogs, blogSchema);

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
    const filter = { slug };
    if (excludeId) filter._id = { $ne: excludeId };
    if (!(await blogs.findOne(filter, { fields: ["slug"] }))) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
};

const parseTags = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s)
        .map((t) => String(t).trim())
        .filter(Boolean);
    } catch (_) {
      /* fall through to CSV */
    }
  }
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
};

const buildAuthor = (body, req) => {
  let author = {};
  if (body.author && typeof body.author === "string" && body.author.startsWith("{")) {
    try {
      author = JSON.parse(body.author);
    } catch (_) {
      /* ignore malformed author JSON */
    }
  }
  return {
    name: body.authorName || author.name || body.author || (req.user && req.user.name) || "Admin",
    avatar: body.authorAvatar || author.avatar || "",
    bio: body.authorBio || author.bio || "",
    slug: body.authorSlug || author.slug || slugify(body.authorName || author.name || "admin"),
  };
};

const LIST_COLUMNS = [
  "id",
  "title",
  "slug",
  "excerpt",
  "cover_image",
  "images",
  "category",
  "tags",
  "author_name",
  "author_avatar",
  "author_bio",
  "author_slug",
  "status",
  "published_at",
  "read_time",
  "views",
  "featured",
  "deletion_requested",
  "deletion_requested_by",
  "deletion_requested_at",
  "meta_title",
  "meta_description",
  "created_by",
  "created_at",
  "updated_at",
].join(", ");

const NEWEST_FIRST = `published_at DESC NULLS LAST, created_at DESC, id`;
const LANDING_RECENT = `published_at DESC NULLS LAST, id`;
const POPULAR = `views DESC, published_at DESC NULLS LAST, id`;

const listBlogs = async (filter, { order = NEWEST_FIRST, limit, skip = 0 } = {}) => {
  const params = [];
  const w = blogs.buildWhere(filter, params);
  let sql = `SELECT ${LIST_COLUMNS} FROM blogs${w.sql ? ` WHERE ${w.sql}` : ""} ORDER BY ${order}`;
  if (limit != null) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  if (skip) {
    params.push(skip);
    sql += ` OFFSET $${params.length}`;
  }
  return (await many(sql, params)).map((r) => stripNulls(blogs.fromRow(r, { lean: true })));
};

const publishedCategoryCounts = async () => {
  const rows = await many(
    `SELECT category, count(*)::int AS count FROM blogs WHERE status = 'published' GROUP BY category`
  );
  const countMap = Object.fromEntries(rows.map((r) => [r.category, r.count]));
  return BLOG_CATEGORIES.map((name) => ({ name, slug: slugify(name), count: countMap[name] || 0 }));
};

const uploadBlogFiles = async (req, { coverImage, authorAvatar }) => {
  const extras = [];
  for (const file of req.files || []) {
    const result = await uploadToR2(file.path, "blogs");
    if (file.fieldname === "coverImage") coverImage = result.secure_url;
    else if (file.fieldname === "authorAvatar") authorAvatar = result.secure_url;
    else extras.push(result.secure_url);
    try {
      fs.unlinkSync(file.path);
    } catch (_) {
      /* temp file already gone */
    }
  }
  return { coverImage, authorAvatar, extras };
};

const trimTag = (t) => (typeof t === "string" ? t.trim() : t);

const blogController = {
  list: async (req, res) => {
    try {
      const { status, category, tag, q, featured, page = 1, limit = 12 } = req.query;
      const filter = {};
      if (status && status !== "all") filter.status = queryEq(status, "blog", "status");
      else if (!status) filter.status = "published";
      if (category) filter.category = queryEq(category, "blog", "category");
      const and = [];
      if (tag) {
        and.push(
          Array.isArray(tag)
            ? { $raw: ["tags = ?::text[]", [tag.map((t) => trimTag(t))]] }
            : { $raw: ["? = ANY(tags)", [trimTag(tag)]] }
        );
      }
      if (featured === "true") filter.featured = true;
      if (q) and.push({ $raw: ["id = ANY(?)", [await textSearchIds(q)]] });
      if (and.length) filter.$and = and;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
      const skip = (pageNum - 1) * lim;

      const [items, total] = await Promise.all([listBlogs(filter, { limit: lim, skip }), blogs.count(filter)]);

      res.status(200).json({ blogs: items, page: pageNum, limit: lim, total, totalPages: Math.ceil(total / lim) });
    } catch (err) {
      console.error("Blog list error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  landing: async (req, res) => {
    try {
      const base = { status: "published" };
      const recents = await listBlogs(base, { order: LANDING_RECENT, limit: 5 });
      const devotional = await listBlogs(base, { order: LANDING_RECENT, limit: 5 });

      const categories = await publishedCategoryCounts();
      const populatedCategories = categories.filter((c) => c.count > 0).slice(0, 6);
      const byCategory = await Promise.all(
        populatedCategories.map(async (cat) => ({
          ...cat,
          items: await listBlogs({ ...base, category: cat.name }, { order: LANDING_RECENT, limit: 6 }),
        }))
      );

      let popular = await listBlogs({ ...base, featured: true }, { order: LANDING_RECENT, limit: 6 });
      if (popular.length < 6) {
        const fill = await listBlogs(base, { order: POPULAR, limit: 6 - popular.length });
        const have = new Set(popular.map((p) => String(p._id)));
        popular = [...popular, ...fill.filter((f) => !have.has(String(f._id)))];
      }

      const recent = await listBlogs(base, { order: LANDING_RECENT, limit: 7 });

      res.status(200).json({ recents, devotional, categories, byCategory, popular, recent });
    } catch (err) {
      console.error("Blog landing error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  categories: async (req, res) => {
    try {
      res.status(200).json({ categories: await publishedCategoryCounts() });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  get: async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const isObjectId = /^[a-f\d]{24}$/i.test(idOrSlug);
      // Mongoose ran the schema's lowercase/trim setters on query values too.
      const blog = await store.findOne(
        isObjectId ? { _id: idOrSlug.toLowerCase() } : { slug: idOrSlug.toLowerCase().trim() }
      );
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      if (blog.status !== "published" && req.query.preview !== "1") {
        return res.status(404).json({ message: "Blog not found" });
      }
      blogs.updateOne({ _id: blog._id }, { $inc: { views: 1 } }).catch(() => {});
      res.status(200).json({ blog });
    } catch (err) {
      console.error("Blog get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  related: async (req, res) => {
    try {
      const id = castQueryId(req.params.id, "blog");
      const current = await blogs.findById(id, { fields: ["category"], lean: true });
      if (!current) return res.status(404).json({ message: "Blog not found" });
      const items = await listBlogs(
        { _id: { $ne: id }, status: "published", category: current.category },
        { order: LANDING_RECENT, limit: 5 }
      );
      res.status(200).json({ items });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      const { title, excerpt, content, category, status, slug, metaTitle, metaDescription, featured } = req.body;

      let coverImage = req.body.coverImage || "";
      let authorAvatar = req.body.authorAvatar || "";
      let extraImages = [];
      ({ coverImage, authorAvatar, extras: extraImages } = await uploadBlogFiles(req, { coverImage, authorAvatar }));

      const baseSlug = slugify(slug || title);
      const uniqueSlug = await ensureUniqueSlug(baseSlug);

      const author = buildAuthor({ ...req.body, authorAvatar }, req);

      const doc = blogSchema.create({
        title,
        slug: uniqueSlug,
        excerpt: excerpt || "",
        content: typeof content === "string" ? sanitizeBlogHtml(content) : content,
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
      doc.readTime = computeReadTime(doc.content);
      if (doc.status === "published" && !doc.publishedAt) doc.publishedAt = new Date();

      const blog = store.shape(await blogs.insert(doc));
      res.status(201).json({ message: "Blog created", blog });
    } catch (err) {
      console.error("Blog create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await store.findById(castQueryId(id, "blog"));
      if (!existing) return res.status(404).json({ message: "Blog not found" });

      let coverImage = req.body.coverImage !== undefined ? req.body.coverImage : existing.coverImage;
      let authorAvatar =
        req.body.authorAvatar !== undefined ? req.body.authorAvatar : (existing.author && existing.author.avatar) || "";
      const uploaded = await uploadBlogFiles(req, { coverImage, authorAvatar });
      ({ coverImage, authorAvatar } = uploaded);
      const newExtras = uploaded.extras;

      const author = buildAuthor({ ...req.body, authorAvatar }, req);

      const body = req.body;
      const patch = {
        title: body.title ?? existing.title,
        excerpt: body.excerpt ?? existing.excerpt,
        content:
          body.content != null
            ? typeof body.content === "string"
              ? sanitizeBlogHtml(body.content)
              : body.content
            : existing.content,
        category: body.category ?? existing.category,
        author,
        status: body.status ?? existing.status,
        metaTitle: body.metaTitle ?? existing.metaTitle,
        metaDescription: body.metaDescription ?? existing.metaDescription,
        coverImage,
        images: newExtras.length ? [...(existing.images || []), ...newExtras] : existing.images,
      };
      if (body.tags !== undefined) patch.tags = parseTags(body.tags);
      if (body.featured !== undefined) {
        patch.featured = body.featured === "true" || body.featured === true;
      }

      if (body.slug !== undefined && body.slug !== existing.slug) {
        const base = slugify(body.slug);
        patch.slug = await ensureUniqueSlug(base, existing._id);
      }

      const { doc, modified } = blogSchema.applySave(existing, patch);
      let blog = existing;
      if (Object.keys(modified).length) {
        if ("content" in modified) modified.readTime = computeReadTime(doc.content);
        if ("status" in modified && doc.status === "published" && !existing.publishedAt) {
          modified.publishedAt = new Date();
        }
        blog = await store.saveChanges(existing._id, modified);
      }

      res.status(200).json({ message: "Blog updated", blog });
    } catch (err) {
      console.error("Blog update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // A blogs_admin's delete files a pending request instead of deleting.
  delete: async (req, res) => {
    try {
      const id = castQueryId(req.params.id, "blog");

      if (req.user.role === "blogs_admin") {
        const blog = await store.updateById(id, {
          deletionRequested: true,
          deletionRequestedBy: req.user.userId,
          deletionRequestedAt: new Date(),
        });
        if (!blog) return res.status(404).json({ message: "Blog not found" });
        return res.status(200).json({
          message: "Deletion requested — an admin needs to approve this before it's removed.",
          blog,
        });
      }

      const blog = await blogs.deleteById(id);
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      res.status(200).json({ message: "Blog deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  deletionRequests: async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT b.id, b.title, b.slug, b.category, b.cover_image, b.deletion_requested_at, b.deletion_requested_by,
                u.id AS u_id, u.name AS u_name, u.email AS u_email
           FROM blogs b LEFT JOIN users u ON u.id = b.deletion_requested_by
          WHERE b.deletion_requested = true
          ORDER BY b.deletion_requested_at DESC NULLS LAST, b.id`
      );
      const items = rows.map((r) => {
        const doc = blogs.fromRow({
          id: r.id,
          title: r.title,
          slug: r.slug,
          category: r.category,
          cover_image: r.cover_image,
          deletion_requested_at: r.deletion_requested_at,
        });
        if (r.u_id) doc.deletionRequestedBy = { _id: r.u_id, name: r.u_name, email: r.u_email };
        else if (r.deletion_requested_by) doc.deletionRequestedBy = null;
        return doc;
      });
      res.status(200).json({ blogs: items });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  approveDeletion: async (req, res) => {
    try {
      const id = castQueryId(req.params.id, "blog");
      const blog = await blogs.findOne({ _id: id, deletionRequested: true }, { fields: ["slug"] });
      if (!blog) return res.status(404).json({ message: "No pending deletion request for this post" });
      await blogs.deleteById(id);
      res.status(200).json({ message: "Deletion approved — post removed" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  rejectDeletion: async (req, res) => {
    try {
      const blog = await store.updateById(castQueryId(req.params.id, "blog"), {
        deletionRequested: false,
        deletionRequestedBy: null,
        deletionRequestedAt: null,
      });
      if (!blog) return res.status(404).json({ message: "Blog not found" });
      res.status(200).json({ message: "Deletion request rejected — post kept", blog });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  uploadInline: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: { message: "No file uploaded" } });
      const result = await uploadToR2(req.file.path, "blogs/inline");
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {
        /* temp file already gone */
      }
      return res.status(200).json({ url: result.secure_url });
    } catch (err) {
      console.error("Blog inline upload error:", err);
      return res.status(500).json({ error: { message: err.message || "Upload failed" } });
    }
  },
};

export { blogController };
