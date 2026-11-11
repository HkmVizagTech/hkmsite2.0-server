const { gitaCourseRegistrationModel } = require("../models/gitaCourseRegistration.model");
const { cleanMobile, isValidMobile, MOBILE_MESSAGE } = require("../utils/mobile");

const BATCHES = ["adults", "youth", "kids"];
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

const gitaCourseController = {
  // PUBLIC - register for the course
  register: async (req, res) => {
    try {
      const b = req.body || {};
      const name = str(b.name, 120);
      const mobile = cleanMobile(b.mobile);
      const batch = str(b.batch, 10).toLowerCase();
      const email = str(b.email, 120).toLowerCase();
      if (!name) return res.status(400).json({ message: "Please enter your name." });
      if (!isValidMobile(mobile)) return res.status(400).json({ message: MOBILE_MESSAGE });
      if (!BATCHES.includes(batch)) return res.status(400).json({ message: "Please choose a batch." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email, or leave it blank." });

      // The same person registering the same batch again just updates their details, so there is one row per mobile and batch.
      const doc = await gitaCourseRegistrationModel.findOneAndUpdate(
        { mobile, batch },
        {
          $set: { name, email, city: str(b.city, 80), language: str(b.language, 40), preferredTime: str(b.preferredTime, 60), kidName: str(b.kidName, 120), note: str(b.note, 500) },
          $setOnInsert: { status: "new" },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.status(201).json({ message: "Registered", id: doc._id });
    } catch (err) {
      console.error("Gita course register error:", err);
      res.status(500).json({ message: "Could not register right now. Please try again." });
    }
  },

  // ADMIN - list, newest first
  list: async (req, res) => {
    try {
      const { batch, status, page = 1, limit = 50 } = req.query;
      const filter = {};
      if (BATCHES.includes(batch)) filter.batch = batch;
      if (["new", "contacted", "added"].includes(status)) filter.status = status;
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const [items, total, counts] = await Promise.all([
        gitaCourseRegistrationModel.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * lim).limit(lim).lean(),
        gitaCourseRegistrationModel.countDocuments(filter),
        gitaCourseRegistrationModel.aggregate([{ $group: { _id: "$batch", n: { $sum: 1 } } }]),
      ]);
      res.status(200).json({ items, total, page: pageNum, totalPages: Math.ceil(total / lim), byBatch: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - update status
  updateStatus: async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!["new", "contacted", "added"].includes(status)) return res.status(400).json({ message: "Invalid status" });
      const doc = await gitaCourseRegistrationModel.findByIdAndUpdate(req.params.id, { status }, { new: true });
      if (!doc) return res.status(404).json({ message: "Not found" });
      res.status(200).json({ message: "Updated", data: doc });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { gitaCourseController };
