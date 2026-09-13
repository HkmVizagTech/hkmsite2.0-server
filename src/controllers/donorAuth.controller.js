const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../utils/utils");
const { donorModel } = require("../models/donor.model");
const { sendDonorOtp, isWhatsAppConfigured } = require("../services/whatsapp.service");

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between requests
const MAX_OTP_ATTEMPTS = 5;

const cleanMobile = (raw) => String(raw || "").replace(/\D/g, "").slice(-10);

const donorAuthController = {
  // POST /donor-auth/send-otp { mobile }
  // Only sends an OTP for a mobile number that already has a Donor
  // record (i.e. has donated before) — a random unrecognized number
  // gets a clear, honest message instead of an OTP, both because
  // there's nothing to show them yet and to avoid this becoming a free
  // way to spam arbitrary numbers with WhatsApp messages.
  sendOtp: async (req, res) => {
    try {
      const mobile = cleanMobile(req.body.mobile);
      if (mobile.length !== 10) {
        return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
      }

      const donor = await donorModel.findOne({ mobile });
      if (!donor) {
        return res.status(404).json({
          success: false,
          message: "We don't have any donation records for this number. If you've donated before, please check the number or contact us.",
        });
      }

      if (donor.otpLastRequestedAt && Date.now() - donor.otpLastRequestedAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - donor.otpLastRequestedAt.getTime())) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${waitSeconds}s before requesting another code.` });
      }

      if (!isWhatsAppConfigured()) {
        return res.status(503).json({ success: false, message: "WhatsApp login isn't available right now. Please try again shortly." });
      }

      const otpCode = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
      const otpCodeHash = await bcrypt.hash(otpCode, 10);

      await sendDonorOtp(donor.mobile, otpCode);

      // Only persist the OTP after a confirmed send — a failed/rejected
      // send (see whatsapp.service.js's assertDelivered) throws before
      // reaching here, so no OTP is stored for a code the donor never
      // actually received.
      await donorModel.findByIdAndUpdate(donor._id, {
        otpCodeHash,
        otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
        otpAttempts: 0,
        otpLastRequestedAt: new Date(),
      });

      res.status(200).json({ success: true, message: "OTP sent via WhatsApp." });
    } catch (err) {
      console.error("donorAuth.sendOtp error:", err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: "Could not send OTP. Please try again." });
    }
  },

  // POST /donor-auth/verify-otp { mobile, otp }
  verifyOtp: async (req, res) => {
    try {
      const mobile = cleanMobile(req.body.mobile);
      const otp = String(req.body.otp || "").trim();
      if (mobile.length !== 10 || !otp) {
        return res.status(400).json({ success: false, message: "Mobile number and OTP are required." });
      }

      const donor = await donorModel.findOne({ mobile });
      if (!donor || !donor.otpCodeHash || !donor.otpExpiresAt) {
        return res.status(400).json({ success: false, message: "Please request a new OTP." });
      }

      if (donor.otpExpiresAt.getTime() < Date.now()) {
        return res.status(400).json({ success: false, message: "This OTP has expired. Please request a new one." });
      }

      if (donor.otpAttempts >= MAX_OTP_ATTEMPTS) {
        return res.status(429).json({ success: false, message: "Too many incorrect attempts. Please request a new OTP." });
      }

      const matches = await bcrypt.compare(otp, donor.otpCodeHash);
      if (!matches) {
        await donorModel.findByIdAndUpdate(donor._id, { $inc: { otpAttempts: 1 } });
        return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });
      }

      // Success — clear the OTP so it can't be reused, issue a session.
      await donorModel.findByIdAndUpdate(donor._id, {
        $unset: { otpCodeHash: "", otpExpiresAt: "", otpLastRequestedAt: "" },
        otpAttempts: 0,
      });

      const token = jwt.sign({ donorId: donor._id, type: "donor" }, getJwtSecret(), { expiresIn: "30d" });
      res.status(200).json({
        success: true,
        token,
        donor: { _id: donor._id, donorId: donor.donorId, name: donor.name, mobile: donor.mobile, email: donor.email },
      });
    } catch (err) {
      console.error("donorAuth.verifyOtp error:", err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: "Could not verify OTP. Please try again." });
    }
  },
};

module.exports = { donorAuthController };
