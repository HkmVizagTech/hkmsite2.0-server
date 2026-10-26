import fs from "node:fs";
import { events } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { pick } from "../domain/validate.js";
import { pipelineBodyError } from "../domain/odm.js";
import { eventSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";
import { slugify } from "../utils/slug.js";

const store = makeStore(events, eventSchema);
const EDITABLE = [
  "title",
  "slug",
  "previousSlugs",
  "description",
  "date",
  "bannerImage",
  "registrationLink",
  "images",
  "registrationForm",
  "category",
  "status",
];

const isObjectId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const slugTaken = (slug) => ({ $or: [{ slug }, { $raw: ["? = ANY(previous_slugs)", [slug]] }] });

/**
 * A slug for `text` that no other event uses (current or previous slug): "gita-jayanti", then
 * "gita-jayanti-2", "-3"... A slug that looks like a database id is suffixed so it can never be mistaken for one.
 */
async function uniqueEventSlug(text, excludeId) {
  let base = slugify(text) || "event";
  if (isObjectId(base)) base = `${base}-event`;
  let candidate = base;
  for (let n = 2; ; n++) {
    const taken = await events.exists({
      ...slugTaken(candidate),
      ...(excludeId ? { _id: { $ne: String(excludeId) } } : {}),
    });
    if (!taken) return candidate;
    candidate = `${base}-${n}`;
  }
}

/** Gives every event that has no slug one, from its title (run at startup). */
async function ensureEventSlugs() {
  const missing = await events.find(
    { $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] },
    { fields: ["title"] }
  );
  for (const ev of missing) {
    await events.updateById(ev._id, { slug: await uniqueEventSlug(ev.title, ev._id) });
  }
  if (missing.length) console.log(`[events] gave ${missing.length} event(s) a web address (slug)`);
}

const eventController = {
  list: async (req, res) => {
    try {
      const items = await store.find({}, { sort: { date: -1, _id: 1 } });
      res.status(200).json({ events: items });
    } catch (err) {
      console.error("Event create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // GET /events/:idOrSlug - by database id (old links, QR passes) or by the event's web address, current or previous.
  get: async (req, res) => {
    try {
      const key = String(req.params.id || "");
      const event = isObjectId(key)
        ? await store.findById(castQueryId(key, "event"))
        : await store.findOne({ $or: [{ slug: key.toLowerCase() }, { $raw: ["? = ANY(previous_slugs)", [key.toLowerCase()]] }] });
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
      const imageUrls = [];
      for (const file of req.files || []) {
        const result = await uploadToR2(file.path, "events");
        imageUrls.push(result.secure_url);
        fs.unlinkSync(file.path);
      }
      const registrationForm = req.body.registrationForm ? JSON.parse(req.body.registrationForm) : undefined;
      const event = await store.create({
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
        createdBy: req.user.userId,
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
      if (req.body && req.body.registrationForm && typeof req.body.registrationForm === "string") {
        try {
          req.body.registrationForm = JSON.parse(req.body.registrationForm);
        } catch (e) {
          /* keep the raw string, as before */
        }
      }
      const castId = castQueryId(id, "event");
      const bad = pipelineBodyError(req.body);
      if (bad) throw bad;
      // Web address: unchanged when the title is edited (links stay valid); an admin-edited slug is cleaned, made
      // unique, and the old one kept in previousSlugs so shared links still resolve.
      const existing = await events.findById(castId, { fields: ["slug", "title", "previousSlugs"] });
      if (!existing) return res.status(404).json({ message: "Event not found" });
      delete req.body.previousSlugs;
      const wanted = typeof req.body.slug === "string" ? slugify(req.body.slug) : "";
      if (wanted && wanted !== existing.slug) {
        req.body.slug = await uniqueEventSlug(wanted, castId);
        if (existing.slug) {
          req.body.previousSlugs = [...new Set([...(existing.previousSlugs || []), existing.slug])].filter(
            (s) => s !== req.body.slug
          );
        }
      } else if (!existing.slug) {
        req.body.slug = await uniqueEventSlug(req.body.title || existing.title, castId);
      } else {
        delete req.body.slug;
      }
      const event = await store.updateById(castId, pick(req.body || {}, EDITABLE));
      if (!event) return res.status(404).json({ message: "Event not found" });
      res.status(200).json({ message: "Event updated", event });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await events.deleteById(castQueryId(req.params.id, "event"));
      res.status(200).json({ message: "Event deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { eventController, ensureEventSlugs, uniqueEventSlug };
