import fs from "node:fs";
import { media } from "../db/tables.js";
import { uploadToR2, deleteFromR2 } from "../utils/r2.js";
import { mediaSchema } from "../domain/schemas.js";
import { makeStore, castQueryId, stripNulls } from "../domain/store.js";
import { compilePcre, regexMatches } from "../domain/pcre.js";

const store = makeStore(media, mediaSchema);

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
        } catch {
          /* temp file already gone */
        }
        const doc = await store.create({
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

  list: async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
      const sort = { createdAt: -1, _id: -1 };

      let items;
      let total;
      if (q) {
        const re = compilePcre(q);
        const all = (await media.find({}, { sort, lean: true }))
          .map(stripNulls)
          .filter((m) => regexMatches(m.name, re) || regexMatches(m.tags, re));
        total = all.length;
        items = all.slice((page - 1) * limit, (page - 1) * limit + limit);
      } else {
        [items, total] = await Promise.all([
          media.find({}, { sort, skip: (page - 1) * limit, limit, lean: true }).then((docs) => docs.map(stripNulls)),
          media.count({}),
        ]);
      }

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
      const item = await store.updateById(castQueryId(req.params.id, "media"), updates);
      if (!item) return res.status(404).json({ message: "Media not found" });
      res.status(200).json({ item });
    } catch (err) {
      console.error("media.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      const item = await store.findById(castQueryId(req.params.id, "media"));
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
