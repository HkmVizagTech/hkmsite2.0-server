const fs = require("fs");
const { heroBannerModel } = require("../models/heroBanner.model");
const { uploadToCloudinary } = require("../utils/cloudinary");

const heroBannerController = {
  // PUBLIC - active banners in display order
  list: async (req, res) => {
    try {
      const includeInactive = req.query.all === "true";
      const filter = includeInactive ? {} : { active: true };
      const banners = await heroBannerModel.find(filter).sort({ order: 1, createdAt: 1 }).lean();
      res.status(200).json({ banners });
    } catch (err) {
      console.error("heroBanner.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN - create with desktop + mobile image upload
  create: async (req, res) => {
    try {
      const { title, order } = req.body;
      const files = req.files || [];
      const desktopFile = files.find((f) => f.fieldname === "desktopImage");
      const mobileFile = files.find((f) => f.fieldname === "mobileImage");

      if (!desktopFile || !mobileFile) {
        return res.status(400).json({ message: "Both desktop and mobile images are required" });
      }

      const [desktopUpload, mobileUpload] = await Promise.all([
        uploadToCloudinary(desktopFile.path, "hero-banners"),
        uploadToCloudinary(mobileFile.path, "hero-banners"),
      ]);
      try { fs.unlinkSync(desktopFile.path); } catch (_) {}
      try { fs.unlinkSync(mobileFile.path); } catch (_) {}

      const count = await heroBannerModel.countDocuments();
      const banner = await heroBannerModel.create({
        title: title || `Banner ${count + 1}`,
        desktopImage: desktopUpload.secure_url,
        mobileImage: mobileUpload.secure_url,
        order: order !== undefined ? Number(order) : count,
        createdBy: req.user ? req.user.userId : undefined,
      });

      res.status(201).json({ message: "Banner created", banner });
    } catch (err) {
      console.error("heroBanner.create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - update (title/order/active, optionally replace one or both images)
  update: async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await heroBannerModel.findById(id);
      if (!existing) return res.status(404).json({ message: "Banner not found" });

      const files = req.files || [];
      const desktopFile = files.find((f) => f.fieldname === "desktopImage");
      const mobileFile = files.find((f) => f.fieldname === "mobileImage");

      const patch = {};
      if (req.body.title !== undefined) patch.title = req.body.title;
      if (req.body.order !== undefined) patch.order = Number(req.body.order);
      if (req.body.active !== undefined) patch.active = req.body.active === "true" || req.body.active === true;

      if (desktopFile) {
        const up = await uploadToCloudinary(desktopFile.path, "hero-banners");
        patch.desktopImage = up.secure_url;
        try { fs.unlinkSync(desktopFile.path); } catch (_) {}
      }
      if (mobileFile) {
        const up = await uploadToCloudinary(mobileFile.path, "hero-banners");
        patch.mobileImage = up.secure_url;
        try { fs.unlinkSync(mobileFile.path); } catch (_) {}
      }

      Object.assign(existing, patch);
      await existing.save();
      res.status(200).json({ message: "Banner updated", banner: existing });
    } catch (err) {
      console.error("heroBanner.update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - delete
  delete: async (req, res) => {
    try {
      const banner = await heroBannerModel.findByIdAndDelete(req.params.id);
      if (!banner) return res.status(404).json({ message: "Banner not found" });
      res.status(200).json({ message: "Banner deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN - reorder (bulk)
  reorder: async (req, res) => {
    try {
      const { order } = req.body; // [{id, order}, ...]
      if (!Array.isArray(order)) return res.status(400).json({ message: "order must be an array" });
      await Promise.all(
        order.map(({ id, order: pos }) => heroBannerModel.findByIdAndUpdate(id, { order: pos }))
      );
      res.status(200).json({ message: "Reordered" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { heroBannerController };
