import fs from "node:fs";
import { media } from "../db/tables.js";
import { uploadToR2, deleteFromR2 } from "../utils/r2.js";

const escapeLike = (s) => s.replace(/[\\%_]/g, "\\$&");

const mediaController = {
  upload: async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: "No files uploaded" });

      const items = [];
      for (const file of files) {
        const up = await uploadToR2(file.path, "media-library");
        try {
          fs.unlinkSync(file.path);
        } catch (_) {
          /* temp file already gone */
        }
        items.push(
          await media.insert({
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
          })
        );
      }
      res.status(201).json({ items });
    } catch (err) {
      console.error("media.upload error:", err);
      res.status(500).json({ message: "Upload failed" });
    }
  },

  list: async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));

      const filter = q
        ? { $raw: ["(name ILIKE ? OR tags ILIKE ?)", [`%${escapeLike(q)}%`, `%${escapeLike(q)}%`]] }
        : {};
      const [items, total] = await Promise.all([
        media.find(filter, { sort: { createdAt: -1, _id: -1 }, skip: (page - 1) * limit, limit }),
        media.count(filter),
      ]);
      res.status(200).json({ items, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
      console.error("media.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const updates = {};
      if (typeof req.body.name === "string") updates.name = req.body.name.trim();
      if (typeof req.body.tags === "string") updates.tags = req.body.tags.trim();
      const item = await media.updateById(req.params.id, updates);
      if (!item) return res.status(404).json({ message: "Media not found" });
      res.status(200).json({ item });
    } catch (err) {
      console.error("media.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      const item = await media.findById(req.params.id);
      if (!item) return res.status(404).json({ message: "Media not found" });
      try {
        await deleteFromR2(item.publicId);
      } catch (e) {
        console.warn("media.delete R2 destroy failed:", item.publicId, e?.message);
      }
      await media.deleteById(item._id);
      res.status(200).json({ message: "Deleted" });
    } catch (err) {
      console.error("media.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { mediaController };
