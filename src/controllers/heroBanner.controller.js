import fs from "node:fs";
import { heroBanners } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { toBool } from "../domain/validate.js";

const uploadBanner = async (file) => {
  const up = await uploadToR2(file.path, "hero-banners");
  try {
    fs.unlinkSync(file.path);
  } catch (_) {
    /* temp file already gone */
  }
  return up.secure_url;
};

const heroBannerController = {
  list: async (req, res) => {
    try {
      const filter = req.query.all === "true" ? {} : { active: true };
      const banners = await heroBanners.find(filter, { sort: { order: 1, createdAt: 1, _id: 1 } });
      res.status(200).json({ banners });
    } catch (err) {
      console.error("heroBanner.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      const { title, order, linkUrl } = req.body;
      const files = req.files || [];
      const desktopFile = files.find((f) => f.fieldname === "desktopImage");
      const mobileFile = files.find((f) => f.fieldname === "mobileImage");

      // A direct URL string is accepted too (used to seed existing static assets).
      let desktopImage = req.body.desktopImage;
      let mobileImage = req.body.mobileImage;
      if (desktopFile) desktopImage = await uploadBanner(desktopFile);
      if (mobileFile) mobileImage = await uploadBanner(mobileFile);

      if (!desktopImage || !mobileImage) {
        return res.status(400).json({ message: "Both desktop and mobile images are required" });
      }

      const count = await heroBanners.count();
      const banner = await heroBanners.insert({
        title: String(title || `Banner ${count + 1}`).trim(),
        desktopImage,
        mobileImage,
        linkUrl: linkUrl ? String(linkUrl).trim() : "",
        order: order !== undefined ? Number(order) : count,
        createdBy: req.user ? req.user.userId : undefined,
      });
      res.status(201).json({ message: "Banner created", banner });
    } catch (err) {
      console.error("heroBanner.create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await heroBanners.findById(id, { fields: ["title"] });
      if (!existing) return res.status(404).json({ message: "Banner not found" });

      const files = req.files || [];
      const desktopFile = files.find((f) => f.fieldname === "desktopImage");
      const mobileFile = files.find((f) => f.fieldname === "mobileImage");

      const patch = {};
      if (req.body.title !== undefined) patch.title = String(req.body.title).trim();
      if (req.body.order !== undefined) patch.order = Number(req.body.order);
      if (req.body.active !== undefined) patch.active = toBool(req.body.active);
      if (req.body.linkUrl !== undefined) patch.linkUrl = String(req.body.linkUrl).trim();
      if (desktopFile) patch.desktopImage = await uploadBanner(desktopFile);
      if (mobileFile) patch.mobileImage = await uploadBanner(mobileFile);

      const banner = await heroBanners.updateById(id, patch);
      res.status(200).json({ message: "Banner updated", banner });
    } catch (err) {
      console.error("heroBanner.update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const banner = await heroBanners.deleteById(req.params.id);
      if (!banner) return res.status(404).json({ message: "Banner not found" });
      res.status(200).json({ message: "Banner deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  reorder: async (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order)) return res.status(400).json({ message: "order must be an array" });
      await Promise.all(order.map(({ id, order: pos }) => heroBanners.updateById(id, { order: pos })));
      res.status(200).json({ message: "Reordered" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { heroBannerController };
