import fs from "node:fs";
import { events } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { validateDoc, pick, toStringArray, toDate } from "../domain/validate.js";

const EVENT_STATUSES = ["upcoming", "completed", "cancelled"];
const EDITABLE = [
  "title",
  "description",
  "date",
  "bannerImage",
  "registrationLink",
  "images",
  "registrationForm",
  "category",
  "status",
];

const eventController = {
  list: async (req, res) => {
    try {
      const items = await events.find({}, { sort: { date: -1, _id: 1 } });
      res.status(200).json({ events: items });
    } catch (err) {
      console.error("Event list error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  get: async (req, res) => {
    try {
      const event = await events.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found" });
      res.status(200).json({ event });
    } catch (err) {
      console.error("Event get error:", err);
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
      validateDoc(
        "event",
        { title, description, date, status },
        { required: ["title", "description", "date"], enums: { status: EVENT_STATUSES } }
      );
      const event = await events.insert({
        title,
        description,
        date: toDate(date),
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
      console.error("Event create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const patch = pick(req.body || {}, EDITABLE);
      if (typeof patch.registrationForm === "string") {
        try {
          patch.registrationForm = JSON.parse(patch.registrationForm);
        } catch (_) {
          delete patch.registrationForm;
        }
      }
      if (patch.date !== undefined) patch.date = toDate(patch.date);
      if (patch.images !== undefined) patch.images = toStringArray(patch.images);
      validateDoc("event", patch, { enums: { status: EVENT_STATUSES } });
      const event = await events.updateById(id, patch);
      if (!event) return res.status(404).json({ message: "Event not found" });
      res.status(200).json({ message: "Event updated", event });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await events.deleteById(req.params.id);
      res.status(200).json({ message: "Event deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { eventController };
