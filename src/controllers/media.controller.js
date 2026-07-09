const fs = require("fs");
const { mediaModel } = require("../models/media.model");
const { cloudinary, uploadToCloudinary } = require("../utils/cloudinary");

const mediaController = {
  // ADMIN — upload one or more images to the media library.
  upload: async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: "No files uploaded" });

      const items = [];
      for (const file of files) {
        const up = await uploadToCloudinary(file.path, "media-library");
        try { fs.unlinkSync(file.path); } catch {}
        const doc = await mediaModel.create({
          name: (req.body.name || file.originalname || "Untitled").trim(),
          url: up.secure_url,
          publicId: up.public_id,
          format: up.format,
          width: up.width,
          height: up.height,
          bytes: up.bytes,
          folder: "media-library",
          tags: (req.body.tags || "").trim(),
          uploadedBy: req.user?._id,
        });
        items.push(doc);
      }

      res.status(201).json({ items });
    } catch (err) {
      console.error("media.upload error:", err);
      res.status(500).json({ message: "Upload failed" });
    }
  },

  // ADMIN — list with optional text search + pagination.
  list: async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));

      const filter = q
        ? { $or: [{ name: { $regex: q, $options: "i" } }, { tags: { $regex: q, $options: "i" } }] }
        : {};

      const [items, total] = await Promise.all([
        mediaModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        mediaModel.countDocuments(filter),
      ]);

      res.status(200).json({ items, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
      console.error("media.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — rename / retag.
  update: async (req, res) => {
    try {
      const updates = {};
      if (typeof req.body.name === "string") updates.name = req.body.name.trim();
      if (typeof req.body.tags === "string") updates.tags = req.body.tags.trim();
      const item = await mediaModel.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!item) return res.status(404).json({ message: "Media not found" });
      res.status(200).json({ item });
    } catch (err) {
      console.error("media.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — delete from Cloudinary and the library.
  delete: async (req, res) => {
    try {
      const item = await mediaModel.findById(req.params.id);
      if (!item) return res.status(404).json({ message: "Media not found" });
      try {
        await cloudinary.uploader.destroy(item.publicId);
      } catch (e) {
        console.warn("media.delete cloudinary destroy failed:", item.publicId, e?.message);
      }
      await item.deleteOne();
      res.status(200).json({ message: "Deleted" });
    } catch (err) {
      console.error("media.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { mediaController };
