// Preacher portal: a preacher signs in with the mobile number on the temple devotee list (OTP by SMS) and sees
// only their own seva links and the donations credited to them. It is not an admin login.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../utils/utils");
const { templeDevoteeModel } = require("../models/templeDevotee.model");
const { preacherOtpModel } = require("../models/preacherOtp.model");
const { donationModel } = require("../models/donation.model");
const { sendOtpSms } = require("../services/sms.service");
const { istDayStart, istDayEnd } = require("../config/timezone");

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const hash = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");
const clean = (raw) => String(raw || "").replace(/\D/g, "").slice(-10);
const PREACHER_SCOPE = { sourcePage: { $not: /^\/?donations(\/|$)/ } };
const rangeMatch = (from, to) => {
  const c = {};
  const a = from ? istDayStart(String(from)) : null;
  const b = to ? istDayEnd(String(to)) : null;
  if (a) c.$gte = a;
  if (b) c.$lte = b;
  return Object.keys(c).length ? { createdAt: c } : {};
};

// Active devotees with a DCC id whose saved mobile is this number (some numbers belong to more than one entry).
async function devoteesFor(mobile) {
  const all = await templeDevoteeModel.find({ status: "active", dccEnrolledById: { $nin: [null, 36] }, mobile: { $exists: true, $ne: "" } }).lean();
  return all.filter((d) => clean(d.mobile) === mobile);
}

/** Express middleware: requires a preacher-portal token; sets req.preacher = { mobile, ids: [dccEnrolledById...] }. */
function requirePreacher(req, res, next) {
  try {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const p = jwt.verify(token, getJwtSecret());
    if (!p || p.type !== "preacherPortal" || !Array.isArray(p.ids) || !p.ids.length) throw new Error("bad token");
    req.preacher = { mobile: p.mobile, ids: p.ids.map(Number) };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Please log in again." });
  }
}

const preacherPortalController = {
  // POST /preacher-portal/send-otp { mobile }
  sendOtp: async (req, res) => {
    try {
      const mobile = clean(req.body.mobile);
      if (!/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
      const list = await devoteesFor(mobile);
      if (!list.length) return res.status(404).json({ success: false, message: "This number is not on the temple's preacher list. Please contact the temple office." });
      const prev = await preacherOtpModel.findById(mobile).lean();
      if (prev && Date.now() - new Date(prev.lastSentAt).getTime() < RESEND_MS) {
        const wait = Math.ceil((RESEND_MS - (Date.now() - new Date(prev.lastSentAt).getTime())) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${wait} seconds before asking for a new code.` });
      }
      const otp = String(crypto.randomInt(100000, 1000000));
      await sendOtpSms(mobile, otp);
      await preacherOtpModel.findByIdAndUpdate(
        mobile,
        { codeHash: hash(otp), expiresAt: new Date(Date.now() + OTP_TTL_MS), attempts: 0, lastSentAt: new Date() },
        { upsert: true }
      );
      res.status(200).json({ success: true, message: "We sent a 6-digit code by SMS." });
    } catch (err) {
      console.error("preacherPortal.sendOtp error:", err && err.message ? err.message : err);
      res.status(502).json({ success: false, message: "We couldn't send the SMS right now. Please try again in a few minutes." });
    }
  },

  // POST /preacher-portal/verify-otp { mobile, otp }
  verifyOtp: async (req, res) => {
    try {
      const mobile = clean(req.body.mobile);
      const otp = String(req.body.otp || "").trim();
      const row = await preacherOtpModel.findById(mobile);
      if (!row) return res.status(400).json({ success: false, message: "Please request a new code." });
      if (row.expiresAt.getTime() < Date.now()) return res.status(400).json({ success: false, message: "This code has expired. Please request a new one." });
      if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ success: false, message: "Too many wrong attempts. Please request a new code." });
      const given = hash(otp);
      if (!(given.length === row.codeHash.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.codeHash)))) {
        row.attempts += 1;
        await row.save();
        return res.status(400).json({ success: false, message: "Incorrect code. Please try again." });
      }
      await preacherOtpModel.deleteOne({ _id: mobile });
      const list = await devoteesFor(mobile);
      if (!list.length) return res.status(403).json({ success: false, message: "This number is no longer on the preacher list." });
      const ids = list.map((d) => Number(d.dccEnrolledById));
      const token = jwt.sign({ type: "preacherPortal", mobile, ids }, getJwtSecret(), { expiresIn: "30d" });
      res.status(200).json({ success: true, token, preachers: list.map((d) => ({ name: d.name, code: d.code || "", dccEnrolledById: d.dccEnrolledById })) });
    } catch (err) {
      console.error("preacherPortal.verifyOtp error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /preacher-portal/dashboard?id=&from=&to=&page=   (id must be one of the signed-in preacher's ids)
  dashboard: async (req, res) => {
    try {
      const ids = req.preacher.ids;
      const id = req.query.id !== undefined && ids.includes(Number(req.query.id)) ? Number(req.query.id) : ids[0];
      const me = await templeDevoteeModel.findOne({ dccEnrolledById: id, status: "active" }).lean();
      if (!me) return res.status(403).json({ success: false, message: "Please log in again." });
      const all = await templeDevoteeModel.find({ dccEnrolledById: { $in: ids }, status: "active" }).select("name code dccEnrolledById").lean();

      const base = { ...PREACHER_SCOPE, dccEnrolledById: id };
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const monthStart = todayStr.slice(0, 8) + "01";
      const sum = async (extra) => {
        const [r] = await donationModel.aggregate([{ $match: { ...base, status: "completed", ...extra } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" }, donors: { $addToSet: "$donorMobile" } } }]);
        return { count: r ? r.count : 0, total: r ? r.total : 0, donors: r ? r.donors.filter(Boolean).length : 0 };
      };
      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const lim = 30;
      const rangeQ = rangeMatch(req.query.from, req.query.to);
      const [today, month, allTime, range, items, total, daily] = await Promise.all([
        sum(rangeMatch(todayStr, todayStr)),
        sum(rangeMatch(monthStart, todayStr)),
        sum({}),
        sum(rangeQ),
        donationModel.find({ ...base, status: "completed", ...rangeQ }).sort({ createdAt: -1 }).skip((pageNum - 1) * lim).limit(lim)
          .select("donorName amount sevaName sourcePage createdAt").lean(),
        donationModel.countDocuments({ ...base, status: "completed", ...rangeQ }),
        donationModel.aggregate([
          { $match: { ...base, status: "completed", ...rangeMatch(monthStart, todayStr) } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+05:30" } }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
      ]);
      res.status(200).json({
        success: true,
        me: { name: me.name, code: me.code || "", dccEnrolledById: me.dccEnrolledById },
        accounts: all.map((d) => ({ name: d.name, code: d.code || "", dccEnrolledById: d.dccEnrolledById })),
        today, month, allTime, range,
        // Donor names only (first name + initial) — no phone numbers or emails in the preacher portal.
        donations: { items: items.map((d) => ({ ...d, donorName: shortName(d.donorName) })), total, page: pageNum, totalPages: Math.ceil(total / lim) },
        daily,
      });
    } catch (err) {
      console.error("preacherPortal.dashboard error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

function shortName(n) {
  const parts = String(n || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Donor";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

module.exports = { preacherPortalController, requirePreacher };
