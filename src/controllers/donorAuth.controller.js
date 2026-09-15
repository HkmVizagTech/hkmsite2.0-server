const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../utils/utils");
const { donorModel } = require("../models/donor.model");
const { sendDonorOtp, isWhatsAppConfigured } = require("../services/whatsapp.service");

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between requests
const MAX_OTP_ATTEMPTS = 5;

const cleanMobile = (raw) => String(raw || "").replace(/\D/g, "").slice(-10);

// SHA-256, not bcrypt, deliberately. bcrypt's whole design point is being
// SLOW (~50-150ms per hash) so that someone who steals a password database
// can't brute-force it offline at billions of guesses/second — worth that
// cost for a credential that's valid indefinitely. An OTP is a different
// threat model entirely: it expires in 10 minutes and this endpoint
// already hard-caps attempts at 5 server-side (MAX_OTP_ATTEMPTS below),
// so bcrypt's slowness added real, measurable latency (confirmed live:
// verify-otp was taking ~0.6s, almost entirely bcrypt.compare) without
// providing any additional protection an attacker's 5 real-time guesses
// could exploit anyway. Still never stored in plaintext — just hashed
// with something that doesn't in this case.
const hashOtp = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");

// Generates, sends and stores a fresh OTP for an existing donor/customer
// record. Shared by the donor portal and the shop so there is exactly one
// implementation of "issue an OTP" — the two entry points differ only in
// whether they're willing to CREATE a record for an unknown number, never in
// how the code itself is generated, delivered or stored.
async function issueOtpForDonor(donor, res) {
  if (donor.otpLastRequestedAt && Date.now() - donor.otpLastRequestedAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - donor.otpLastRequestedAt.getTime())) / 1000);
    return res.status(429).json({ success: false, message: `Please wait ${waitSeconds}s before requesting another code.` });
  }

  if (!isWhatsAppConfigured()) {
    return res.status(503).json({ success: false, message: "WhatsApp login isn't available right now. Please try again shortly." });
  }

  const otpCode = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const otpCodeHash = hashOtp(otpCode);

  await sendDonorOtp(donor.mobile, otpCode);

  // Only persist the OTP after a confirmed send — a failed/rejected send
  // (see whatsapp.service.js's assertDelivered) throws before reaching here,
  // so no OTP is stored for a code the person never actually received.
  await donorModel.findByIdAndUpdate(donor._id, {
    otpCodeHash,
    otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
    otpAttempts: 0,
    otpLastRequestedAt: new Date(),
  });

  return res.status(200).json({ success: true, message: "OTP sent via WhatsApp." });
}

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

      return await issueOtpForDonor(donor, res);
    } catch (err) {
      console.error("donorAuth.sendOtp error:", err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: "Could not send OTP. Please try again." });
    }
  },

  // POST /donor-auth/shop/send-otp { mobile, name }
  // The shop's entry point. Unlike sendOtp above, this one ACCEPTS a number
  // with no existing record and creates a customer identity on the spot —
  // a first-time book buyer has never donated, and refusing them would mean
  // nobody new could ever check out.
  //
  // That deliberately gives up the "only known numbers" protection the donor
  // portal relies on, so the guard rails here are the route's rate limits
  // (see donorAuth.routes.js) plus the same per-number 60s cooldown, applied
  // by issueOtpForDonor to new and existing records alike.
  sendShopOtp: async (req, res) => {
    try {
      const mobile = cleanMobile(req.body.mobile);
      if (mobile.length !== 10) {
        return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
      }

      const { findOrCreateShopCustomer } = require("../services/donor.service");
      const donor = await findOrCreateShopCustomer({
        mobile,
        name: req.body.name ? String(req.body.name).slice(0, 120) : undefined,
      });

      return await issueOtpForDonor(donor, res);
    } catch (err) {
      console.error("donorAuth.sendShopOtp error:", err && err.message ? err.message : err);
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

      const providedHash = hashOtp(otp);
      const matches = providedHash.length === donor.otpCodeHash.length
        && crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(donor.otpCodeHash));
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
