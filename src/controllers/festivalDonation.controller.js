import { festivalDonations, donations, events } from "../db/tables.js";
import { many, newId, isId } from "../db/pg.js";
import { splitUser, toBool, toStringArray } from "../domain/validate.js";

const PUBLIC_FIELDS = ["title", "slug", "description", "images", "active", "donationOptions", "meta", "createdAt"];

const normalizeOptions = (list) =>
  (Array.isArray(list) ? list : []).map((o) => {
    const out = { _id: isId(o?._id) ? o._id : newId() };
    if (o?.label !== undefined) out.label = String(o.label);
    if (o?.amount !== undefined && o.amount !== null && o.amount !== "") out.amount = Number(o.amount);
    if (o?.description !== undefined) out.description = String(o.description);
    return out;
  });

// Only fields the admin form can set; never _id, createdAt, createdBy.
const writableFields = (body) => {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title);
  if (body.description !== undefined) out.description = body.description === null ? null : String(body.description);
  if (body.images !== undefined) out.images = toStringArray(body.images) || [];
  if (body.active !== undefined) out.active = toBool(body.active);
  if (body.donationOptions !== undefined) out.donationOptions = normalizeOptions(body.donationOptions);
  if (body.eventId !== undefined) out.eventId = body.eventId || null;
  if (body.meta !== undefined) out.meta = body.meta && typeof body.meta === "object" ? body.meta : null;
  return out;
};

const loadPopulated = async (where, params) => {
  const rows = await many(
    `SELECT f.*, u.id AS u_id, u.name AS u_name, u.email AS u_email
       FROM festival_donations f LEFT JOIN users u ON u.id = f.created_by
      ${where} ORDER BY f.created_at, f.id`,
    params
  );
  const eventIds = [...new Set(rows.map((r) => r.event_id).filter(Boolean))];
  const eventDocs = eventIds.length ? await events.find({ _id: { $in: eventIds } }) : [];
  const eventMap = new Map(eventDocs.map((e) => [e._id, e]));
  return rows.map((row) => {
    const [rest, user] = splitUser(row);
    const doc = festivalDonations.fromRow(rest);
    if (user) doc.createdBy = user;
    if (rest.event_id) doc.eventId = eventMap.get(rest.event_id) || null;
    return doc;
  });
};

const festivalDonationController = {
  publicList: async (req, res) => {
    try {
      const festivals = await festivalDonations.find(
        { active: true, slug: { $ne: "" }, title: { $ne: "" } },
        { fields: PUBLIC_FIELDS, sort: { createdAt: 1, _id: 1 } }
      );
      const clean = festivals.map((doc) => {
        if (doc.title) doc.title = String(doc.title).trim();
        if (doc.slug) doc.slug = String(doc.slug).trim();
        return doc;
      });
      if (!clean.length) return res.json({ message: "Currently there are no festivals" });
      res.json(clean);
    } catch (err) {
      console.error("festivalDonationController.publicList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  list: async (req, res) => {
    try {
      const festivals = await loadPopulated("", []);
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
      const slug = String(req.params.slug || "").trim();
      const [festival] = await loadPopulated("WHERE f.slug = $1", [slug]);
      if (!festival) return res.status(404).json({ message: "Festival donation page not found" });

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
      let { slug } = req.body;
      if (slug) slug = String(slug).trim();
      if (!req.body.title || !slug) return res.status(400).json({ message: "Title and slug are required" });
      if (await festivalDonations.findOne({ slug }, { fields: ["slug"] })) {
        return res.status(409).json({ message: "Slug already exists" });
      }
      const { eventId, ...fields } = writableFields(req.body); // create has never accepted eventId
      const page = await festivalDonations.insert({ ...fields, slug, createdBy: req.user.userId });
      res.status(201).json({ message: "Festival donation page created", page });
    } catch (err) {
      console.error("festivalDonationController.create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const patch = writableFields(req.body);
      if (req.body.slug) patch.slug = String(req.body.slug).trim();
      const page = await festivalDonations.updateById(req.params.id, patch);
      if (!page) return res.status(404).json({ message: "Festival page not found" });
      res.status(200).json({ message: "Festival donation page updated", page });
    } catch (err) {
      console.error("festivalDonationController.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await festivalDonations.deleteById(req.params.id);
      res.status(200).json({ message: "Festival donation page deleted" });
    } catch (err) {
      console.error("festivalDonationController.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { festivalDonationController };
