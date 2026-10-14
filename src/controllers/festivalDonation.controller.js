import { festivalDonations, donations, events, users } from "../db/tables.js";
import { many } from "../db/pg.js";
import { pick } from "../domain/validate.js";
import { pipelineBodyError } from "../domain/odm.js";
import { festivalDonationSchema, eventSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";

const store = makeStore(festivalDonations, festivalDonationSchema);

const PUBLIC_FIELDS = ["title", "slug", "description", "images", "active", "donationOptions", "meta", "createdAt"];
// Fields the admin form can set; create never accepted eventId.
const EDITABLE = ["title", "slug", "description", "images", "active", "donationOptions", "eventId", "meta"];

// populate('createdBy', 'name email') and populate('eventId'): dangling references become null.
const populate = async (docs) => {
  const userIds = [...new Set(docs.map((d) => d.createdBy).filter(Boolean))];
  const eventIds = [...new Set(docs.map((d) => d.eventId).filter(Boolean))];
  const [found, eventDocs] = await Promise.all([
    userIds.length ? users.find({ _id: { $in: userIds } }, { fields: ["name", "email"], lean: true }) : [],
    eventIds.length ? events.find({ _id: { $in: eventIds } }) : [],
  ]);
  const userMap = new Map(found.map((u) => [u._id, u]));
  const eventMap = new Map(eventDocs.map((e) => [e._id, eventSchema.shape(e)]));
  return docs.map((d) => {
    const out = { ...d };
    if (d.createdBy) out.createdBy = userMap.get(d.createdBy) || null;
    if (d.eventId) out.eventId = eventMap.get(d.eventId) || null;
    return out;
  });
};

const festivalDonationController = {
  publicList: async (req, res) => {
    try {
      const festivals = await store.find(
        { active: true, slug: { $ne: "" }, title: { $ne: "" } },
        { fields: PUBLIC_FIELDS, sort: { createdAt: 1, _id: 1 } }
      );
      const clean = festivals.map((doc) => {
        if (doc.title) doc.title = String(doc.title).trim();
        if (doc.slug) doc.slug = String(doc.slug).trim();
        return doc;
      });
      if (!clean || clean.length === 0) {
        return res.json({ message: "Currently there are no festivals" });
      }
      res.json(clean);
    } catch (err) {
      console.error("festivalDonationController.publicList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  list: async (req, res) => {
    try {
      const festivals = await populate(await store.find({}, { sort: { _id: 1 } }));
      const counts = await many(
        `SELECT festival_id, count(*)::int AS n FROM donations WHERE festival_id IS NOT NULL GROUP BY festival_id`
      );
      const countMap = new Map(counts.map((c) => [c.festival_id, c.n]));
      res.json(festivals.map((f) => ({ ...f, event: f.eventId, donationCount: countMap.get(f._id) || 0 })));
    } catch (err) {
      console.error("festivalDonationController.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  getBySlug: async (req, res) => {
    try {
      const rawSlug = req.params.slug || "";
      const slug = String(rawSlug).trim();
      const [festival] = await populate([await store.findOne({ slug })].filter(Boolean));
      if (!festival) {
        return res.status(404).json({ message: "Festival donation page not found" });
      }
      const recent = await donations.find(
        { $or: [{ festivalId: festival._id }, { festivalSlug: slug }] },
        { sort: { createdAt: -1, _id: -1 }, limit: 10 }
      );
      res.json({ ...festival, event: festival.eventId, donations: recent });
    } catch (err) {
      console.error("festivalDonationController.getBySlug error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      let { title, slug, description, images, donationOptions, meta } = req.body;
      if (slug) slug = String(slug).trim();
      if (!title || !slug) return res.status(400).json({ message: "Title and slug are required" });
      const exists = await festivalDonations.findOne({ slug }, { fields: ["slug"] });
      if (exists) return res.status(409).json({ message: "Slug already exists" });
      const page = await store.create({
        title,
        slug,
        description,
        images,
        donationOptions,
        meta,
        createdBy: req.user.userId,
      });
      res.status(201).json({ message: "Festival donation page created", page });
    } catch (err) {
      console.error("festivalDonationController.create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (req.body.slug) req.body.slug = String(req.body.slug).trim();
      const castId = castQueryId(id, "festivalDonation");
      const bad = pipelineBodyError(req.body);
      if (bad) throw bad;
      const page = await store.updateById(castId, pick(req.body, EDITABLE));
      if (!page) return res.status(404).json({ message: "Festival page not found" });
      res.status(200).json({ message: "Festival donation page updated", page });
    } catch (err) {
      console.error("festivalDonationController.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await festivalDonations.deleteById(castQueryId(req.params.id, "festivalDonation"));
      res.status(200).json({ message: "Festival donation page deleted" });
    } catch (err) {
      console.error("festivalDonationController.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { festivalDonationController };
