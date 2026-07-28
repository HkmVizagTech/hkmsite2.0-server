const { templeDevoteeModel } = require("../models/templeDevotee.model");

const templeDevoteeController = {
  // PUBLIC — names + ids only, for the campaigner registration dropdown.
  // Never exposes dccEnrolledById or any other internal field.
  publicList: async (req, res) => {
    try {
      const devotees = await templeDevoteeModel
        .find({ status: "active" })
        .sort({ name: 1 })
        .select("name")
        .lean();
      res.status(200).json({ success: true, devotees });
    } catch (err) {
      console.error("templeDevotee.publicList error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // ADMIN — full list including hidden + DCC ids
  adminList: async (req, res) => {
    try {
      const devotees = await templeDevoteeModel.find({}).sort({ name: 1 }).lean();
      res.status(200).json({ success: true, devotees });
    } catch (err) {
      console.error("templeDevotee.adminList error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // ADMIN — add a devotee
  create: async (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      if (name.length < 2) return res.status(400).json({ success: false, message: "Please provide the devotee's name." });
      const dccEnrolledById = req.body.dccEnrolledById != null && req.body.dccEnrolledById !== ""
        ? Number(req.body.dccEnrolledById)
        : null;
      if (dccEnrolledById != null && !Number.isFinite(dccEnrolledById)) {
        return res.status(400).json({ success: false, message: "DCC Enrolled-By ID must be a number." });
      }
      const devotee = await templeDevoteeModel.create({ name, dccEnrolledById });
      res.status(201).json({ success: true, devotee });
    } catch (err) {
      console.error("templeDevotee.create error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // ADMIN — update name / dcc id / status
  update: async (req, res) => {
    try {
      const updates = {};
      if (req.body.name != null) {
        const name = String(req.body.name).trim();
        if (name.length < 2) return res.status(400).json({ success: false, message: "Name too short." });
        updates.name = name;
      }
      if (req.body.dccEnrolledById !== undefined) {
        updates.dccEnrolledById = req.body.dccEnrolledById === null || req.body.dccEnrolledById === ""
          ? null
          : Number(req.body.dccEnrolledById);
        if (updates.dccEnrolledById != null && !Number.isFinite(updates.dccEnrolledById)) {
          return res.status(400).json({ success: false, message: "DCC Enrolled-By ID must be a number." });
        }
      }
      if (req.body.status != null) {
        updates.status = req.body.status === "hidden" ? "hidden" : "active";
      }
      const devotee = await templeDevoteeModel.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!devotee) return res.status(404).json({ success: false, message: "Devotee not found" });
      res.status(200).json({ success: true, devotee });
    } catch (err) {
      console.error("templeDevotee.update error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

module.exports = { templeDevoteeController };
