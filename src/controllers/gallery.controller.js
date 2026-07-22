const { galleryModel } = require("../models/gallery.model");
const { uploadToR2 } = require("../utils/r2");

const galleryController = {
  // POST /gallery/upload-image — upload a single image to R2 and return
  // its URL so the admin page can collect URLs before creating a gallery
  // entry. Matches the same pattern as donations-admin/upload-image,
  // media library, etc.
  uploadImage: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const result = await uploadToR2(req.file.path, "gallery");
      const fs = require("fs");
      fs.unlink(req.file.path, () => {});
      res.status(200).json({ secure_url: result.secure_url });
    } catch (error) {
      console.error("gallery.uploadImage error:", error);
      res.status(500).json({ message: error.message || "Image upload failed" });
    }
  },

  list: async (req, res) => {
    try {
      const { category, type, date } = req.query;
      let filter = {};
      if (category) filter.category = category;
      if (type) filter.type = type;
      if (date) {
        const start = new Date(date);
        const end = new Date(date);
        end.setHours(23, 59, 59, 999);
        filter.date = { $gte: start, $lte: end };
      }
      const items = await galleryModel.find(filter).sort({ date: -1 });
      res.status(200).json({ items });
    } catch (err) {
      console.error("Gallery list error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },

  get: async (req, res) => {
    try {
      const item = await galleryModel.findById(req.params.id);
      if (!item) return res.status(404).json({ message: "Gallery item not found" });
      res.status(200).json({ item });
    } catch (err) {
      console.error("Gallery get error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },

  create: async (req, res) => {
    try {
      const { title, description, images, date, category, type, status } = req.body;
      const item = await galleryModel.create({
        title, description, images, date, category, type, status,
        createdBy: req.user.userId
      });
      res.status(201).json({ message: "Gallery item created", item });
    } catch (err) {
      console.error("Gallery create error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const item = await galleryModel.findByIdAndUpdate(id, req.body, { new: true });
      if (!item) return res.status(404).json({ message: "Gallery item not found" });
      res.status(200).json({ message: "Gallery item updated", item });
    } catch (err) {
      console.error("Gallery update error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      await galleryModel.findByIdAndDelete(id);
      res.status(200).json({ message: "Gallery item deleted" });
    } catch (err) {
      console.error("Gallery delete error:", err && err.stack ? err.stack : err);
      res.status(500).json({ message: "Server error", error: err && err.message ? err.message : String(err) });
    }
  }
};

module.exports = { galleryController };
