const { templeDevoteeModel } = require("../models/templeDevotee.model");
const { donationModel } = require("../models/donation.model");
const { istDayStart, istDayEnd } = require("../config/timezone");

const cleanCode = (v) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
// Donations credited to a preacher: a DCC enrolled-by ID other than the temple default (36), outside /donations.
const PREACHER_SCOPE = { sourcePage: { $not: /^\/?donations(\/|$)/ }, dccEnrolledById: { $nin: [null, 36] } };
const rangeMatch = (from, to) => {
  const c = {};
  const a = from ? istDayStart(String(from)) : null;
  const b = to ? istDayEnd(String(to)) : null;
  if (a) c.$gte = a;
  if (b) c.$lte = b;
  return Object.keys(c).length ? { createdAt: c } : {};
};

const templeDevoteeController = {
  // PUBLIC — names + ids only, for the campaigner registration dropdown.
  // Never exposes dccEnrolledById or any other internal field.
  publicList: async (req, res) => {
    try {
      const devotees = await templeDevoteeModel
        .find({ status: "active" })
        .sort({ name: 1 })
        .select("name code")
        .lean();
      // Entries imported without a real name (stored under their code) stay out of the public dropdown.
      res.status(200).json({ success: true, devotees: devotees.filter((d) => d.name !== d.code).map((d) => ({ _id: d._id, name: d.name })) });
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
      const code = cleanCode(req.body.code) || undefined;
      if (code && (await templeDevoteeModel.exists({ code }))) return res.status(400).json({ success: false, message: `Code ${code} is already used.` });
      const devotee = await templeDevoteeModel.create({ name, dccEnrolledById, code, mobile: String(req.body.mobile || "").trim(), email: String(req.body.email || "").trim() });
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
      if (req.body.code !== undefined) {
        const code = cleanCode(req.body.code);
        if (code && (await templeDevoteeModel.exists({ code, _id: { $ne: req.params.id } }))) return res.status(400).json({ success: false, message: `Code ${code} is already used.` });
        updates.code = code || undefined;
        if (!code) updates.$unset = { code: "" };
      }
      if (req.body.mobile !== undefined) updates.mobile = String(req.body.mobile || "").trim();
      if (req.body.email !== undefined) updates.email = String(req.body.email || "").trim().toLowerCase();
      if (req.body.status != null) {
        updates.status = req.body.status === "hidden" ? "hidden" : "active";
      }
      if (updates.$unset) delete updates.code;
      const devotee = await templeDevoteeModel.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!devotee) return res.status(404).json({ success: false, message: "Devotee not found" });
      res.status(200).json({ success: true, devotee });
    } catch (err) {
      console.error("templeDevotee.update error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // ADMIN — preacher analytics: completed donations credited to each preacher (by DCC enrolled-by ID), with an
  // optional date range (YYYY-MM-DD, IST). With ?id=<dccEnrolledById> also returns that preacher's donations.
  analytics: async (req, res) => {
    try {
      const { from, to, id, page = 1 } = req.query;
      const base = { ...PREACHER_SCOPE, status: "completed", ...rangeMatch(from, to) };
      const [rows, devotees] = await Promise.all([
        donationModel.aggregate([
          { $match: base },
          { $group: { _id: "$dccEnrolledById", count: { $sum: 1 }, total: { $sum: "$amount" }, donors: { $addToSet: "$donorMobile" }, last: { $max: "$createdAt" } } },
          { $sort: { total: -1 } },
        ]),
        templeDevoteeModel.find({}).select("name code dccEnrolledById status").lean(),
      ]);
      const byId = new Map(devotees.filter((d) => d.dccEnrolledById != null).map((d) => [Number(d.dccEnrolledById), d]));
      const preachers = rows.map((r) => {
        const d = byId.get(Number(r._id));
        return { dccEnrolledById: r._id, name: d ? d.name : `ID ${r._id}`, code: d?.code || "", count: r.count, total: r.total, donors: r.donors.filter(Boolean).length, last: r.last };
      });
      const totals = preachers.reduce((a, p) => ({ count: a.count + p.count, total: a.total + p.total }), { count: 0, total: 0 });

      let donations = null;
      if (id !== undefined && id !== "" && Number.isFinite(Number(id))) {
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const lim = 50;
        const match = { ...PREACHER_SCOPE, dccEnrolledById: Number(id), ...rangeMatch(from, to) };
        const [items, total, daily] = await Promise.all([
          donationModel.find(match).sort({ createdAt: -1 }).skip((pageNum - 1) * lim).limit(lim)
            .select("donorName donorMobile donorEmail amount sevaName sourcePage status createdAt receiptNumber dccSyncStatus preacherCode campaignerSlug manualPaymentMode").lean(),
          donationModel.countDocuments(match),
          donationModel.aggregate([
            { $match: { ...match, status: "completed" } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+05:30" } }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ]),
        ]);
        donations = { items, total, page: pageNum, totalPages: Math.ceil(total / lim), daily };
      }
      res.status(200).json({ success: true, preachers, totals, devotees: devotees.filter((d) => d.dccEnrolledById != null && Number(d.dccEnrolledById) !== 36), donations });
    } catch (err) {
      console.error("templeDevotee.analytics error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

module.exports = { templeDevoteeController };
