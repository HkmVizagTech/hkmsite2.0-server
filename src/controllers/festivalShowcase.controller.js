import { festivalShowcases, users } from "../db/tables.js";
import { pick } from "../domain/validate.js";
import { pipelineBodyError } from "../domain/odm.js";
import { festivalShowcaseSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";

const store = makeStore(festivalShowcases, festivalShowcaseSchema);

// Fields the admin form can set; never createdBy.
const WRITABLE = [
  "title",
  "slug",
  "subtitle",
  "heroImage",
  "cardImage",
  "eventDate",
  "location",
  "description",
  "status",
  "featured",
  "featuredOrder",
  "active",
  "ctaLabel",
  "ctaHref",
  "donateEnabled",
  "customLink",
  "gallery",
  "schedule",
  "details",
  "testimonials",
];
// create also took `_id`, `createdAt` and `updatedAt` straight from the body.
const CREATABLE = [...WRITABLE, "_id", "createdAt", "updatedAt"];

const SORT_FEATURED = { featured: -1, featuredOrder: 1 };

// Mongoose `populate("createdBy", "name email")`: a dangling reference becomes null.
const populateCreator = async (docs) => {
  const ids = [...new Set(docs.map((d) => d.createdBy).filter(Boolean))];
  const found = ids.length ? await users.find({ _id: { $in: ids } }, { fields: ["name", "email"], lean: true }) : [];
  const byId = new Map(found.map((u) => [u._id, u]));
  return docs.map((d) => (d.createdBy ? { ...d, createdBy: byId.get(d.createdBy) || null } : d));
};

const festivalShowcaseController = {
  publicList: async (req, res) => {
    try {
      const showcases = await store.find(
        { active: true },
        { sort: { ...SORT_FEATURED, eventDate: -1, _id: 1 } }
      );
      res.json(
        showcases.map((doc) => {
          const { createdBy, active, ...rest } = doc;
          return rest;
        })
      );
    } catch (err) {
      console.error("festivalShowcaseController.publicList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  getBySlug: async (req, res) => {
    try {
      const rawSlug = req.params.slug || "";
      const slug = String(rawSlug).trim();
      const showcase = await store.findOne({ slug, active: true });
      if (!showcase) {
        return res.status(404).json({ message: "Festival not found" });
      }
      res.json(showcase);
    } catch (err) {
      console.error("festivalShowcaseController.getBySlug error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  list: async (req, res) => {
    try {
      const showcases = await store.find({}, { sort: { ...SORT_FEATURED, updatedAt: -1, _id: 1 } });
      res.json(await populateCreator(showcases));
    } catch (err) {
      console.error("festivalShowcaseController.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      let { title, slug } = req.body;
      if (slug) slug = String(slug).trim();
      if (!title || !slug) {
        return res.status(400).json({ message: "Title and slug are required" });
      }
      const exists = await festivalShowcases.findOne({ slug }, { fields: ["slug"] });
      if (exists) return res.status(409).json({ message: "Slug already exists" });
      const page = await store.create({
        ...pick(req.body, CREATABLE),
        slug,
        createdBy: req.user.userId,
      });
      res.status(201).json({ message: "Festival showcase created", page });
    } catch (err) {
      console.error("festivalShowcaseController.create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (req.body.slug) req.body.slug = String(req.body.slug).trim();
      const castId = castQueryId(id, "festivalShowcase");
      const bad = pipelineBodyError(req.body);
      if (bad) throw bad;
      const page = await store.updateById(castId, pick(req.body, WRITABLE));
      if (!page) return res.status(404).json({ message: "Festival showcase not found" });
      res.status(200).json({ message: "Festival showcase updated", page });
    } catch (err) {
      console.error("festivalShowcaseController.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await festivalShowcases.deleteById(castQueryId(req.params.id, "festivalShowcase"));
      res.status(200).json({ message: "Festival showcase deleted" });
    } catch (err) {
      console.error("festivalShowcaseController.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { festivalShowcaseController };
