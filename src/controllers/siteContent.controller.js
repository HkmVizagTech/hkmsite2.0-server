const { siteContentModel } = require("../models/siteContent.model");

const siteContentController = {
  // PUBLIC - fetch site content (creates the default singleton on first read)
  get: async (req, res) => {
    try {
      let content = await siteContentModel.findOne({ key: "main" });
      if (!content) {
        content = await siteContentModel.create({ key: "main" });
      }
      res.status(200).json({ content });
    } catch (err) {
      console.error("Site content get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - update any subset of hero/about/contact
  update: async (req, res) => {
    try {
      const { hero, about, contact } = req.body;
      const patch = { updatedBy: req.user?.userId };
      if (hero) patch.hero = hero;
      if (about) patch.about = about;
      if (contact) patch.contact = contact;

      const content = await siteContentModel.findOneAndUpdate(
        { key: "main" },
        { $set: patch },
        { new: true, upsert: true }
      );
      res.status(200).json({ message: "Content updated", content });
    } catch (err) {
      console.error("Site content update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { siteContentController };
