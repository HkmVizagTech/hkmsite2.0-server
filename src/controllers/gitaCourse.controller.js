const mongoose = require("mongoose");
const { gitaCourseRegistrationModel } = require("../models/gitaCourseRegistration.model");
const { gitaBatchModel } = require("../models/gitaBatch.model");
const { cleanMobile, isValidMobile, MOBILE_MESSAGE } = require("../utils/mobile");
const { istDayStart, istDayEnd } = require("../config/timezone");

const AGE_GROUPS = ["adults", "youth", "kids"];
const LANGUAGES = ["English", "Telugu"];
const REG_STATUSES = ["new", "contacted", "added", "completed", "dropped"];
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

// Today's date in India, as a Date at 00:00 IST.
const todayIst = () => istDayStart(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));

/** upcoming | running | completed, from the batch dates (IST calendar days). */
function batchPhase(b, now = new Date()) {
  if (now < b.startDate) return "upcoming";
  if (now > b.endDate) return "completed";
  return "running";
}

// The earliest batch for this age group and language that is open for registration, has not ended and has room.
async function findOpenBatch(ageGroup, language) {
  const candidates = await gitaBatchModel
    .find({ ageGroup, language, registrationOpen: true, endDate: { $gte: todayIst() } })
    .sort({ startDate: 1 })
    .lean();
  for (const b of candidates) {
    if (!b.capacity) return b;
    const n = await gitaCourseRegistrationModel.countDocuments({ batchId: b._id, status: { $ne: "dropped" } });
    if (n < b.capacity) return b;
  }
  return null;
}

// Parses YYYY-MM-DD as an IST day; end dates run to 23:59:59.999 IST.
function parseBatchBody(body, partial) {
  const out = {};
  const errors = [];
  if (!partial || body.name !== undefined) {
    out.name = str(body.name, 120);
    if (!out.name) errors.push("Batch name is required.");
  }
  if (!partial || body.ageGroup !== undefined) {
    out.ageGroup = str(body.ageGroup, 10).toLowerCase();
    if (!AGE_GROUPS.includes(out.ageGroup)) errors.push("Age group must be adults, youth or kids.");
  }
  if (!partial || body.language !== undefined) {
    out.language = str(body.language, 10);
    if (!LANGUAGES.includes(out.language)) errors.push("Language must be English or Telugu.");
  }
  if (!partial || body.startDate !== undefined) {
    out.startDate = istDayStart(str(body.startDate, 10));
    if (!out.startDate) errors.push("Start date is required (YYYY-MM-DD).");
  }
  if (!partial || body.endDate !== undefined) {
    out.endDate = istDayEnd(str(body.endDate, 10));
    if (!out.endDate) errors.push("End date is required (YYYY-MM-DD).");
  }
  if (body.classTime !== undefined) out.classTime = str(body.classTime, 80);
  if (body.whatsappLink !== undefined) {
    out.whatsappLink = str(body.whatsappLink, 300);
    if (out.whatsappLink && !/^https:\/\//i.test(out.whatsappLink)) errors.push("WhatsApp link must start with https://");
  }
  if (body.capacity !== undefined) out.capacity = Math.max(0, parseInt(body.capacity, 10) || 0);
  if (body.registrationOpen !== undefined) out.registrationOpen = body.registrationOpen === true || body.registrationOpen === "true";
  if (body.notes !== undefined) out.notes = str(body.notes, 500);
  return { out, errors };
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const istDate = (d) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(d)) : "");
const istDateTime = (d) =>
  d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "";

function registrationFilter(q) {
  const filter = {};
  if (q.batchId === "none") filter.batchId = null;
  else if (isId(q.batchId)) filter.batchId = new mongoose.Types.ObjectId(String(q.batchId));
  if (AGE_GROUPS.includes(q.ageGroup)) filter.batch = q.ageGroup;
  if (LANGUAGES.includes(q.language)) filter.language = q.language;
  if (REG_STATUSES.includes(q.status)) filter.status = q.status;
  const search = str(q.q, 60);
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { mobile: rx }, { email: rx }, { city: rx }, { kidName: rx }];
  }
  return filter;
}

const gitaCourseController = {
  // PUBLIC - register for the course; placed in the next open batch for the age group and language
  register: async (req, res) => {
    try {
      const b = req.body || {};
      const name = str(b.name, 120);
      const mobile = cleanMobile(b.mobile);
      const ageGroup = str(b.batch, 10).toLowerCase();
      const email = str(b.email, 120).toLowerCase();
      const language = str(b.language, 10);
      if (!name) return res.status(400).json({ message: "Please enter your name." });
      if (!isValidMobile(mobile)) return res.status(400).json({ message: MOBILE_MESSAGE });
      if (!AGE_GROUPS.includes(ageGroup)) return res.status(400).json({ message: "Please choose a batch." });
      if (!LANGUAGES.includes(language)) return res.status(400).json({ message: "Please choose the class language: English or Telugu." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email, or leave it blank." });

      // Someone registering again keeps the batch they are already in (if it has not ended); otherwise the next open batch.
      let batch = null;
      const mine = await gitaCourseRegistrationModel.find({ mobile, batch: ageGroup, batchId: { $ne: null } }).populate("batchId").lean();
      const current = mine.map((r) => r.batchId).find((b) => b && b.language === language && b.endDate >= todayIst());
      batch = current || (await findOpenBatch(ageGroup, language));
      // One row per person per batch: registering again for the same batch just updates their details.
      const doc = await gitaCourseRegistrationModel.findOneAndUpdate(
        { mobile, batch: ageGroup, batchId: batch ? batch._id : null },
        {
          $set: { name, email, language, city: str(b.city, 80), preferredTime: str(b.preferredTime, 60), kidName: str(b.kidName, 120), note: str(b.note, 500) },
          $setOnInsert: { status: "new" },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.status(201).json({
        message: "Registered",
        id: doc._id,
        batch: batch ? { name: batch.name, startDate: istDate(batch.startDate), classTime: batch.classTime } : null,
        whatsappLink: batch ? batch.whatsappLink || "" : "",
      });
    } catch (err) {
      console.error("Gita course register error:", err);
      res.status(500).json({ message: "Could not register right now. Please try again." });
    }
  },

  // ---------- ADMIN: batches ----------
  listBatches: async (req, res) => {
    try {
      const batches = await gitaBatchModel.find().sort({ startDate: -1 }).lean();
      const counts = await gitaCourseRegistrationModel.aggregate([
        { $match: { batchId: { $ne: null } } },
        { $group: { _id: { b: "$batchId", s: "$status" }, n: { $sum: 1 } } },
      ]);
      const by = {};
      for (const c of counts) {
        const k = String(c._id.b);
        by[k] = by[k] || { total: 0 };
        by[k][c._id.s] = c.n;
        by[k].total += c.n;
      }
      const unassigned = await gitaCourseRegistrationModel.countDocuments({ batchId: null });
      const now = new Date();
      res.status(200).json({
        batches: batches.map((b) => ({ ...b, phase: batchPhase(b, now), counts: by[String(b._id)] || { total: 0 } })),
        unassigned,
      });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  createBatch: async (req, res) => {
    try {
      const { out, errors } = parseBatchBody(req.body || {}, false);
      if (!errors.length && out.endDate <= out.startDate) errors.push("End date must be on or after the start date.");
      if (errors.length) return res.status(400).json({ message: errors.join(" ") });
      const batch = await gitaBatchModel.create(out);
      res.status(201).json({ message: "Batch created", batch });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  updateBatch: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid batch" });
      const batch = await gitaBatchModel.findById(req.params.id);
      if (!batch) return res.status(404).json({ message: "Batch not found" });
      const { out, errors } = parseBatchBody(req.body || {}, true);
      if (errors.length) return res.status(400).json({ message: errors.join(" ") });
      Object.assign(batch, out);
      if (batch.endDate <= batch.startDate) return res.status(400).json({ message: "End date must be on or after the start date." });
      await batch.save();
      res.status(200).json({ message: "Batch updated", batch });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  deleteBatch: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid batch" });
      const n = await gitaCourseRegistrationModel.countDocuments({ batchId: req.params.id });
      if (n > 0) return res.status(400).json({ message: `This batch has ${n} registrations. Move them to another batch first, or close registration instead of deleting.` });
      const b = await gitaBatchModel.findByIdAndDelete(req.params.id);
      if (!b) return res.status(404).json({ message: "Batch not found" });
      res.status(200).json({ message: "Batch deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ---------- ADMIN: registrations ----------
  list: async (req, res) => {
    try {
      const { page = 1, limit = 50 } = req.query;
      const filter = registrationFilter(req.query);
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const [items, total] = await Promise.all([
        gitaCourseRegistrationModel.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * lim).limit(lim).populate("batchId", "name startDate endDate").lean(),
        gitaCourseRegistrationModel.countDocuments(filter),
      ]);
      res.status(200).json({ items, total, page: pageNum, totalPages: Math.ceil(total / lim) });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // Update one registration's status and/or batch. Body: { status?, batchId? ("" or null = unassigned) }
  updateRegistration: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid registration" });
      const patch = {};
      const { status, batchId } = req.body || {};
      if (status !== undefined) {
        if (!REG_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status" });
        patch.status = status;
      }
      if (batchId !== undefined) {
        if (batchId === "" || batchId === null) patch.batchId = null;
        else if (!isId(batchId) || !(await gitaBatchModel.exists({ _id: batchId }))) return res.status(400).json({ message: "Batch not found" });
        else patch.batchId = batchId;
      }
      const doc = await gitaCourseRegistrationModel.findByIdAndUpdate(req.params.id, patch, { new: true }).populate("batchId", "name startDate endDate");
      if (!doc) return res.status(404).json({ message: "Not found" });
      res.status(200).json({ message: "Updated", data: doc });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // Move many registrations at once. Body: { ids: [...], batchId?, status? }
  bulkUpdate: async (req, res) => {
    try {
      const { ids, batchId, status } = req.body || {};
      const list = Array.isArray(ids) ? ids.filter(isId) : [];
      if (!list.length) return res.status(400).json({ message: "No registrations selected" });
      const patch = {};
      if (status !== undefined) {
        if (!REG_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status" });
        patch.status = status;
      }
      if (batchId !== undefined) {
        if (batchId === "" || batchId === null) patch.batchId = null;
        else if (!isId(batchId) || !(await gitaBatchModel.exists({ _id: batchId }))) return res.status(400).json({ message: "Batch not found" });
        else patch.batchId = batchId;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ message: "Nothing to change" });
      const r = await gitaCourseRegistrationModel.updateMany({ _id: { $in: list } }, { $set: patch });
      res.status(200).json({ message: "Updated", modified: r.modifiedCount });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // CSV of registrations with the same filters as the list (batchId, ageGroup, language, status, q)
  exportCsv: async (req, res) => {
    try {
      const filter = registrationFilter(req.query);
      const rows = await gitaCourseRegistrationModel.find(filter).sort({ createdAt: 1 }).populate("batchId", "name startDate endDate classTime").lean();
      const head = ["Registered on", "Name", "Child's name", "WhatsApp number", "Email", "City", "Age group", "Language", "Preferred time", "Batch", "Batch start", "Batch end", "Class time", "Status"];
      const lines = [head.join(",")];
      for (const r of rows) {
        const b = r.batchId || {};
        lines.push(
          [istDateTime(r.createdAt), r.name, r.kidName, r.mobile, r.email, r.city, r.batch, r.language, r.preferredTime, b.name || "Not assigned", istDate(b.startDate), istDate(b.endDate), b.classTime || "", r.status]
            .map(csvCell)
            .join(",")
        );
      }
      let label = "all";
      if (isId(req.query.batchId)) {
        const b = await gitaBatchModel.findById(req.query.batchId).lean();
        if (b) label = b.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "batch";
      } else if (req.query.batchId === "none") label = "unassigned";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="gita-registrations-${label}-${istDate(new Date())}.csv"`);
      res.status(200).send("﻿" + lines.join("\r\n") + "\r\n");
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // Kept for older admin screens: update status only
  updateStatus: async (req, res) => {
    req.body = { status: (req.body || {}).status };
    return gitaCourseController.updateRegistration(req, res);
  },
};

module.exports = { gitaCourseController };
