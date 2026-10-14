import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../utils/utils.js";
import { donors } from "../db/tables.js";
import { sendDonorOtp, isWhatsAppConfigured } from "../services/whatsapp.service.js";
import { findOrCreateShopCustomer } from "../services/donor.service.js";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between requests
const MAX_OTP_ATTEMPTS = 5;

const cleanMobile = (raw) =>
  String(raw || "")
    .replace(/\D/g, "")
    .slice(-10);

// SHA-256 rather than bcrypt: the OTP lives 10 minutes with at most 5 attempts, so a slow hash adds latency but no protection.
const hashOtp = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");

// Generates, sends and stores a fresh OTP; shared by the donor portal and the shop.
async function issueOtpForDonor(donor, res) {
  if (donor.otpLastRequestedAt && Date.now() - donor.otpLastRequestedAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - donor.otpLastRequestedAt.getTime())) / 1000);
    return res
      .status(429)
      .json({ success: false, message: `Please wait ${waitSeconds}s before requesting another code.` });
  }

  if (!isWhatsAppConfigured()) {
    return res
      .status(503)
      .json({ success: false, message: "WhatsApp login isn't available right now. Please try again shortly." });
  }

  const otpCode = String(crypto.randomInt(100000, 1000000)); // 6 digits
  const otpCodeHash = hashOtp(otpCode);

  // Send first, store only after the provider accepted it, then answer (a failed send must not leave a usable OTP).
  await sendDonorOtp(donor.mobile, otpCode);

  await donors.updateById(donor._id, {
    otpCodeHash,
    otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
    otpAttempts: 0,
    otpLastRequestedAt: new Date(),
  });

  return res.status(200).json({ success: true, message: "OTP sent via WhatsApp." });
}

// Distinguishes a WhatsApp provider outage from a rejected message so the donor gets the right advice.
const otpFailureMessage = (err) => {
  const raw = String((err && err.message) || err || "").toLowerCase();
  const providerDown =
    raw.includes("timed out") ||
    raw.includes("timeout") ||
    raw.includes("fetch failed") ||
    raw.includes("econn") ||
    raw.includes("enotfound") ||
    raw.includes("socket hang up") ||
    raw.includes("network") ||
    raw.includes("502") ||
    raw.includes("503") ||
    raw.includes("522") ||
    raw.includes("cloudflare");

  return providerDown
    ? "Our WhatsApp provider isn't responding right now, so the code couldn't be sent. Please try again in a few minutes."
    : "We couldn't send the code to this number on WhatsApp. Please check the number, or contact us if it keeps failing.";
};

const donorAuthController = {
  // POST /donor-auth/send-otp { mobile }
  sendOtp: async (req, res) => {
    try {
      const mobile = cleanMobile(req.body.mobile);
      if (mobile.length !== 10) {
        return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
      }

      const donor = await donors.findOne({ mobile });
      if (!donor) {
        return res.status(404).json({
          success: false,
          message:
            "We don't have any donation records for this number. If you've donated before, please check the number or contact us.",
        });
      }

      return await issueOtpForDonor(donor, res);
    } catch (err) {
      console.error("donorAuth.sendOtp error:", err && err.message ? err.message : err);
      res.status(502).json({ success: false, message: otpFailureMessage(err) });
    }
  },

  // POST /donor-auth/shop/send-otp { mobile, name }
  sendShopOtp: async (req, res) => {
    try {
      const mobile = cleanMobile(req.body.mobile);
      if (mobile.length !== 10) {
        return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
      }

      const donor = await findOrCreateShopCustomer({
        mobile,
        name: req.body.name ? String(req.body.name).slice(0, 120) : undefined,
      });

      return await issueOtpForDonor(donor, res);
    } catch (err) {
      console.error("donorAuth.sendShopOtp error:", err && err.message ? err.message : err);
      res.status(502).json({ success: false, message: otpFailureMessage(err) });
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

      const donor = await donors.findOne({ mobile });
      if (!donor || !donor.otpCodeHash || !donor.otpExpiresAt) {
        return res.status(400).json({ success: false, message: "Please request a new OTP." });
      }

      if (donor.otpExpiresAt.getTime() < Date.now()) {
        return res.status(400).json({ success: false, message: "This OTP has expired. Please request a new one." });
      }

      if (donor.otpAttempts >= MAX_OTP_ATTEMPTS) {
        return res
          .status(429)
          .json({ success: false, message: "Too many incorrect attempts. Please request a new OTP." });
      }

      const providedHash = hashOtp(otp);
      const matches =
        providedHash.length === donor.otpCodeHash.length &&
        crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(donor.otpCodeHash));
      if (!matches) {
        await donors.updateById(donor._id, { $inc: { otpAttempts: 1 } });
        return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });
      }

      // Success — clear the OTP so it can't be reused, issue a session.
      await donors.updateById(donor._id, {
        $unset: ["otpCodeHash", "otpExpiresAt", "otpLastRequestedAt"],
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

export { donorAuthController };
