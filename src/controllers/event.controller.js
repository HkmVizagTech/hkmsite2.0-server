const { eventModel } = require("../models/event.model");
const { uploadToR2 } = require("../utils/r2");
const fs = require("fs");
const { slugify } = require("../utils/slug");

const isObjectId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));

/**
 * A slug for `text` that no other event uses (current or previous slug):
 * "gita-jayanti", then "gita-jayanti-2", "-3"… A slug that looks like a
 * database id is suffixed so it can never be mistaken for one.
 */
async function uniqueEventSlug(text, excludeId) {
  let base = slugify(text) || "event";
  if (isObjectId(base)) base = `${base}-event`;
  let candidate = base;
  for (let n = 2; ; n++) {
    const taken = await eventModel.exists({
      $or: [{ slug: candidate }, { previousSlugs: candidate }],
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!taken) return candidate;
    candidate = `${base}-${n}`;
  }
}

/** Gives every event that has no slug one, from its title (run at startup). */
async function ensureEventSlugs() {
  const missing = await eventModel.find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] }).select("_id title");
  for (const ev of missing) {
    await eventModel.updateOne({ _id: ev._id }, { slug: await uniqueEventSlug(ev.title, ev._id) });
  }
  if (missing.length) console.log(`[events] gave ${missing.length} event(s) a web address (slug)`);
}

const eventController = {
  list: async (req, res) => {
    try {
      const events = await eventModel.find().sort({ date: -1 });
      res.status(200).json({ events });
    } catch (err) {
      console.error("Event create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // GET /events/:idOrSlug — by database id (old links, QR passes) or by the
  // event's web address, current or previous.
  get: async (req, res) => {
    try {
      const key = String(req.params.id || "");
      const event = isObjectId(key)
        ? await eventModel.findById(key)
        : await eventModel.findOne({ $or: [{ slug: key.toLowerCase() }, { previousSlugs: key.toLowerCase() }] });
      if (!event) return res.status(404).json({ message: "Event not found" });
      res.status(200).json({ event });
    } catch (err) {
      console.error("Event update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  create: async (req, res) => {
    try {
      const { title, description, date, category, status } = req.body;
      let imageUrls = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const result = await uploadToR2(file.path, "events");
          imageUrls.push(result.secure_url);
          fs.unlinkSync(file.path); // Remove temp file
        }
      }
      const registrationForm = req.body.registrationForm ? JSON.parse(req.body.registrationForm) : undefined;
      const event = await eventModel.create({
        title,
        slug: await uniqueEventSlug(req.body.slug || title),
        description,
        date,
        bannerImage: req.body.bannerImage || undefined,
        registrationLink: req.body.registrationLink || undefined,
        images: imageUrls,
        category,
        status,
        registrationForm,
        createdBy: req.user.userId
      });
      res.status(201).json({ message: "Event created", event });
    } catch (err) {
      console.error("Event delete error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (req.body && req.body.registrationForm && typeof req.body.registrationForm === 'string') {
        try { req.body.registrationForm = JSON.parse(req.body.registrationForm); } catch (e) { 
 }
      }
      // Web address: unchanged when the title is edited (links stay valid);
      // an admin-edited slug is cleaned, made unique, and the old one kept
      // in previousSlugs so shared links still resolve.
      const existing = await eventModel.findById(id).select("slug title previousSlugs");
      if (!existing) return res.status(404).json({ message: "Event not found" });
      delete req.body.previousSlugs;
      const wanted = typeof req.body.slug === "string" ? slugify(req.body.slug) : "";
      if (wanted && wanted !== existing.slug) {
        req.body.slug = await uniqueEventSlug(wanted, id);
        if (existing.slug) {
          req.body.previousSlugs = [...new Set([...(existing.previousSlugs || []), existing.slug])].filter((s) => s !== req.body.slug);
        }
      } else if (!existing.slug) {
        req.body.slug = await uniqueEventSlug(req.body.title || existing.title, id);
      } else {
        delete req.body.slug;
      }
      const event = await eventModel.findByIdAndUpdate(id, req.body, { new: true });
      if (!event) return res.status(404).json({ message: "Event not found" });
  res.status(200).json({ message: "Event updated", event });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      await eventModel.findByIdAndDelete(id);
      res.status(200).json({ message: "Event deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  }
};

module.exports = { eventController, ensureEventSlugs, uniqueEventSlug };
