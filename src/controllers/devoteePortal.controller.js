// Devotee login: a devotee on the temple devotee list (the same list the preacher portal uses) signs in with their
// mobile number and a code sent by SMS + WhatsApp. The session is the same kind of token the admin panel uses, with
// role "devotee", which can only open the read-only programs dashboard (see programsViewMiddleware).
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../utils/utils");
const { templeDevoteeModel } = require("../models/templeDevotee.model");
const { preacherOtpModel } = require("../models/preacherOtp.model");
const { sendOtpSms, isSmsConfigured } = require("../services/sms.service");
const { sendDonorOtp, isWhatsAppConfigured } = require("../services/whatsapp.service");

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const hash = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");
const clean = (raw) => String(raw || "").replace(/\D/g, "").slice(-10);
// Codes live in the preacher OTP collection under their own key, so a preacher-portal code is never valid here.
const otpKey = (mobile) => `devotee:${mobile}`;

// Same list and same rule as the preacher portal login (preacherPortal.controller.js devoteesFor), so one number
// logs in to both: active people on the temple list with a DCC id and this saved mobile.
async function devoteesFor(mobile) {
  const all = await templeDevoteeModel.find({ status: "active", dccEnrolledById: { $nin: [null, 36] }, mobile: { $exists: true, $ne: "" } }).select("name mobile").lean();
  return all.filter((d) => clean(d.mobile) === mobile);
}

const devoteePortalController = {
  // POST /devotee-portal/send-otp { mobile }
  sendOtp: async (req, res) => {
    try {
      const mobile = clean(req.body.mobile);
      if (!/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
      if (!(await devoteesFor(mobile)).length) return res.status(404).json({ success: false, message: "This number is not on the temple's devotee list. Please contact the temple office." });
      const key = otpKey(mobile);
      const prev = await preacherOtpModel.findById(key).lean();
      if (prev && Date.now() - new Date(prev.lastSentAt).getTime() < RESEND_MS) {
        const wait = Math.ceil((RESEND_MS - (Date.now() - new Date(prev.lastSentAt).getTime())) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${wait} seconds before asking for a new code.` });
      }
      const otp = String(crypto.randomInt(100000, 1000000));
      const errMsg = (e) => String((e && e.message) || e).slice(0, 300);
      const [sms, wa] = await Promise.allSettled([
        isSmsConfigured() ? sendOtpSms(mobile, otp) : Promise.reject(new Error("SMS not configured")),
        isWhatsAppConfigured() ? sendDonorOtp(mobile, otp) : Promise.reject(new Error("WhatsApp not configured")),
      ]);
      if (sms.status === "rejected") console.warn("devoteePortal.sendOtp SMS failed:", errMsg(sms.reason));
      if (wa.status === "rejected") console.warn("devoteePortal.sendOtp WhatsApp failed:", errMsg(wa.reason));
      if (sms.status === "rejected" && wa.status === "rejected") throw new Error("Neither SMS nor WhatsApp accepted the code");
      await preacherOtpModel.findByIdAndUpdate(
        key,
        {
          codeHash: hash(otp),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          attempts: 0,
          lastSentAt: new Date(),
          smsAckId: sms.status === "fulfilled" ? (sms.value && sms.value.ackid) || null : null,
          smsError: sms.status === "rejected" ? errMsg(sms.reason) : null,
          whatsappSent: wa.status === "fulfilled",
          whatsappError: wa.status === "rejected" ? errMsg(wa.reason) : null,
        },
        { upsert: true }
      );
      const via = [sms.status === "fulfilled" && "SMS", wa.status === "fulfilled" && "WhatsApp"].filter(Boolean);
      res.status(200).json({ success: true, via, message: `We sent a 6-digit code by ${via.join(" and ")}.` });
    } catch (err) {
      console.error("devoteePortal.sendOtp error:", err && err.message ? err.message : err);
      res.status(502).json({ success: false, message: "We couldn't send the code right now. Please try again in a few minutes." });
    }
  },

  // POST /devotee-portal/verify-otp { mobile, otp }  ->  { token, user }
  verifyOtp: async (req, res) => {
    try {
      const mobile = clean(req.body.mobile);
      const otp = String(req.body.otp || "").trim();
      const key = otpKey(mobile);
      const row = await preacherOtpModel.findById(key);
      if (!row) return res.status(400).json({ success: false, message: "Please request a new code." });
      if (row.expiresAt.getTime() < Date.now()) return res.status(400).json({ success: false, message: "This code has expired. Please request a new one." });
      if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ success: false, message: "Too many wrong attempts. Please request a new code." });
      const given = hash(otp);
      if (!(given.length === row.codeHash.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.codeHash)))) {
        row.attempts += 1;
        await row.save();
        return res.status(400).json({ success: false, message: "Incorrect code. Please try again." });
      }
      await preacherOtpModel.deleteOne({ _id: key });
      const list = await devoteesFor(mobile);
      if (!list.length) return res.status(403).json({ success: false, message: "This number is no longer on the devotee list." });
      const name = list[0].name;
      // No userId on purpose: this session is not an admin user account, and every route that needs one rejects it.
      const token = jwt.sign({ type: "devoteePortal", role: "devotee", mobile, name }, getJwtSecret(), { expiresIn: "30d" });
      res.status(200).json({ success: true, token, user: { email: mobile, name, role: "devotee" } });
    } catch (err) {
      console.error("devoteePortal.verifyOtp error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

module.exports = { devoteePortalController };
