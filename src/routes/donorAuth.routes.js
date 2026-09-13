const express = require("express");
const rateLimit = require("express-rate-limit");
const { donorAuthController } = require("../controllers/donorAuth.controller");

const donorAuthRouter = express.Router();

// Tighter than the payment-order limiter — this is a fully public,
// unauthenticated endpoint that triggers a real (costed) WhatsApp send
// per call, and the per-mobile-number cooldown in the controller only
// protects a single number, not this IP hammering many different ones.
const otpRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many OTP requests — please wait a moment and try again." },
});

const verifyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts — please wait a moment and try again." },
});

donorAuthRouter.post("/send-otp", otpRateLimit, donorAuthController.sendOtp);
donorAuthRouter.post("/verify-otp", verifyRateLimit, donorAuthController.verifyOtp);

module.exports = { donorAuthRouter };
