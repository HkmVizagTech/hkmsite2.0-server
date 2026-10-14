import { festivalShowcases } from "../db/tables.js";
import { many } from "../db/pg.js";
import { splitUser, toBool, toStringArray, toDate } from "../domain/validate.js";

const STATUSES = ["upcoming", "completed", "annual"];

const opt = (v) => (v === undefined ? undefined : v === null ? null : String(v));

// Only fields the admin form can set; never _id, createdAt, createdBy.
const writableFields = (body) => {
  const out = {};
  for (const k of [
    "title",
    "subtitle",
    "heroImage",
    "cardImage",
    "location",
    "description",
    "ctaLabel",
    "ctaHref",
    "customLink",
  ]) {
    if (body[k] !== undefined) out[k] = opt(body[k]);
  }
  if (body.eventDate !== undefined) out.eventDate = toDate(body.eventDate, "eventDate");
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status))
      throw new Error(
        `festivalShowcase validation failed: status: \`${body.status}\` is not a valid enum value for path \`status\`.`
      );
    out.status = body.status;
  }
  for (const k of ["featured", "active", "donateEnabled"]) if (body[k] !== undefined) out[k] = toBool(body[k]);
  if (body.featuredOrder !== undefined) out.featuredOrder = Number(body.featuredOrder) || 0;
  if (body.gallery !== undefined) out.gallery = toStringArray(body.gallery) || [];
  if (body.schedule !== undefined) {
    out.schedule = (Array.isArray(body.schedule) ? body.schedule : []).map((s) => ({
      start: opt(s?.start),
      title: opt(s?.title),
      description: opt(s?.description),
    }));
  }
  if (body.details !== undefined) {
    out.details = (Array.isArray(body.details) ? body.details : []).map((d) => ({
      heading: opt(d?.heading),
      body: opt(d?.body),
      image: opt(d?.image),
    }));
  }
  if (body.testimonials !== undefined) {
    out.testimonials = (Array.isArray(body.testimonials) ? body.testimonials : []).map((t) => {
      const rating = t?.rating === undefined || t?.rating === null || t?.rating === "" ? undefined : Number(t.rating);
      if (rating !== undefined && (!(rating >= 1) || rating > 5)) {
        throw new Error("festivalShowcase validation failed: testimonials.rating must be between 1 and 5");
      }
      return { name: opt(t?.name), role: opt(t?.role), message: opt(t?.message), rating, avatar: opt(t?.avatar) };
    });
    // undefined values are dropped by JSON.stringify
  }
  return out;
};

const FEATURED_ORDER = `f.featured DESC, f.featured_order ASC`;

const festivalShowcaseController = {
  publicList: async (req, res) => {
    try {
      const rows = await many(
        `SELECT * FROM festival_showcases WHERE active = true
          ORDER BY featured DESC, featured_order ASC, event_date DESC NULLS LAST, id`
      );
      res.json(
        rows.map((r) => {
          const { createdBy, active, ...doc } = festivalShowcases.fromRow(r);
          return doc;
        })
      );
    } catch (err) {
      console.error("festivalShowcaseController.publicList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  getBySlug: async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const showcase = await festivalShowcases.findOne({ slug, active: true });
      if (!showcase) return res.status(404).json({ message: "Festival not found" });
      res.json(showcase);
    } catch (err) {
      console.error("festivalShowcaseController.getBySlug error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  list: async (req, res) => {
    try {
      const rows = await many(
        `SELECT f.*, u.id AS u_id, u.name AS u_name, u.email AS u_email
           FROM festival_showcases f LEFT JOIN users u ON u.id = f.created_by
          ORDER BY ${FEATURED_ORDER}, f.updated_at DESC, f.id`
      );
      res.json(
        rows.map((row) => {
          const [rest, user] = splitUser(row);
          const doc = festivalShowcases.fromRow(rest);
          if (user) doc.createdBy = user;
          return doc;
        })
      );
    } catch (err) {
      console.error("festivalShowcaseController.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      let { title, slug } = req.body;
      if (slug) slug = String(slug).trim();
      if (!title || !slug) return res.status(400).json({ message: "Title and slug are required" });
      if (await festivalShowcases.findOne({ slug }, { fields: ["slug"] })) {
        return res.status(409).json({ message: "Slug already exists" });
      }
      const page = await festivalShowcases.insert({ ...writableFields(req.body), slug, createdBy: req.user.userId });
      res.status(201).json({ message: "Festival showcase created", page });
    } catch (err) {
      console.error("festivalShowcaseController.create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const patch = writableFields(req.body);
      if (req.body.slug) patch.slug = String(req.body.slug).trim();
      const page = await festivalShowcases.updateById(req.params.id, patch);
      if (!page) return res.status(404).json({ message: "Festival showcase not found" });
      res.status(200).json({ message: "Festival showcase updated", page });
    } catch (err) {
      console.error("festivalShowcaseController.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await festivalShowcases.deleteById(req.params.id);
      res.status(200).json({ message: "Festival showcase deleted" });
    } catch (err) {
      console.error("festivalShowcaseController.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { festivalShowcaseController };
