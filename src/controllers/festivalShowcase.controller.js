const { festivalShowcaseModel } = require("../models/festivalShowcase.model");

const festivalShowcaseController = {
  /** Public list for the /festival index — active showcases, featured on top. */
  publicList: async (req, res) => {
    try {
      const showcases = await festivalShowcaseModel
        .find({ active: true })
        .sort({ featured: -1, eventDate: -1 })
        .select("-createdBy -active");
      res.json(showcases);
    } catch (err) {
      console.error("festivalShowcaseController.publicList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  /** Public single showcase for /festivals/[slug]. */
  getBySlug: async (req, res) => {
    try {
      const rawSlug = req.params.slug || "";
      const slug = String(rawSlug).trim();
      const showcase = await festivalShowcaseModel.findOne({ slug, active: true });
      if (!showcase) {
        return res.status(404).json({ message: "Festival not found" });
      }
      res.json(showcase);
    } catch (err) {
      console.error("festivalShowcaseController.getBySlug error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  /** Admin list — includes inactive items and editors. */
  list: async (req, res) => {
    try {
      const showcases = await festivalShowcaseModel
        .find()
        .sort({ featured: -1, updatedAt: -1 })
        .populate("createdBy", "name email");
      res.json(showcases);
    } catch (err) {
      console.error("festivalShowcaseController.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      let { title, slug } = req.body;
      if (slug) slug = String(slug).trim();
      if (!title || !slug) {
        return res.status(400).json({ message: "Title and slug are required" });
      }
      const exists = await festivalShowcaseModel.findOne({ slug });
      if (exists) return res.status(409).json({ message: "Slug already exists" });
      const page = await festivalShowcaseModel.create({
        ...req.body,
        slug,
        createdBy: req.user.userId,
      });
      res.status(201).json({ message: "Festival showcase created", page });
    } catch (err) {
      console.error("festivalShowcaseController.create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (req.body.slug) req.body.slug = String(req.body.slug).trim();
      const page = await festivalShowcaseModel.findByIdAndUpdate(id, req.body, { new: true });
      if (!page) return res.status(404).json({ message: "Festival showcase not found" });
      res.status(200).json({ message: "Festival showcase updated", page });
    } catch (err) {
      console.error("festivalShowcaseController.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      await festivalShowcaseModel.findByIdAndDelete(id);
      res.status(200).json({ message: "Festival showcase deleted" });
    } catch (err) {
      console.error("festivalShowcaseController.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { festivalShowcaseController };