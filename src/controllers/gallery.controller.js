import fs from "node:fs";
import { galleries } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { istDayStart, istDayEnd } from "../config/timezone.js";
import { validateDoc, pick, toStringArray, toDate } from "../domain/validate.js";

const TYPES = ["darshan", "festival", "seva", "community", "other"];
const STATUSES = ["active", "inactive"];
const EDITABLE = ["title", "description", "images", "date", "category", "type", "status"];

const fail = (res, label, err) => {
  console.error(`${label}:`, err && err.stack ? err.stack : err);
  res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
};

const galleryController = {
  uploadImage: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const result = await uploadToR2(req.file.path, "gallery");
      fs.unlink(req.file.path, () => {});
      res.status(200).json({ secure_url: result.secure_url });
    } catch (error) {
      console.error("gallery.uploadImage error:", error);
      res.status(500).json({ message: error.message || "Image upload failed" });
    }
  },

  list: async (req, res) => {
    try {
      const { category, type, date, status } = req.query;
      const filter = {};
      if (category) filter.category = category;
      if (type) filter.type = type;
      if (status) filter.status = status;
      if (date) {
        const start = istDayStart(date);
        const end = istDayEnd(date);
        if (start && end) filter.date = { $gte: start, $lte: end };
      }
      const items = await galleries.find(filter, { sort: { date: -1, _id: 1 } });
      res.status(200).json({ items });
    } catch (err) {
      fail(res, "Gallery list error", err);
    }
  },

  get: async (req, res) => {
    try {
      const item = await galleries.findById(req.params.id);
      if (!item) return res.status(404).json({ message: "Gallery item not found" });
      res.status(200).json({ item });
    } catch (err) {
      fail(res, "Gallery get error", err);
    }
  },

  create: async (req, res) => {
    try {
      const { title, description, images, date, category, type, status } = req.body;
      validateDoc(
        "gallery",
        { title, date, type, status },
        { required: ["title", "date"], enums: { type: TYPES, status: STATUSES } }
      );
      const item = await galleries.insert({
        title,
        description,
        images: toStringArray(images) || [],
        date: toDate(date),
        category,
        type,
        status,
        createdBy: req.user.userId,
      });
      res.status(201).json({ message: "Gallery item created", item });
    } catch (err) {
      fail(res, "Gallery create error", err);
    }
  },

  update: async (req, res) => {
    try {
      const patch = pick(req.body || {}, EDITABLE);
      if (patch.images !== undefined) patch.images = toStringArray(patch.images) || [];
      if (patch.date !== undefined) patch.date = toDate(patch.date);
      validateDoc("gallery", patch, { enums: { type: TYPES, status: STATUSES } });
      const item = await galleries.updateById(req.params.id, patch);
      if (!item) return res.status(404).json({ message: "Gallery item not found" });
      res.status(200).json({ message: "Gallery item updated", item });
    } catch (err) {
      fail(res, "Gallery update error", err);
    }
  },

  delete: async (req, res) => {
    try {
      await galleries.deleteById(req.params.id);
      res.status(200).json({ message: "Gallery item deleted" });
    } catch (err) {
      fail(res, "Gallery delete error", err);
    }
  },
};

export { galleryController };
