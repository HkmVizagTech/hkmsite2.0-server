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

// Stricter still than the donor limiter above, and deliberately so. The shop
// endpoint will create a record for a number it has never seen, which means
// it WILL send a WhatsApp message to any number given to it — exactly the
// abuse vector the donor endpoint avoids by refusing unknown numbers. A
// longer window with a small budget makes bulk abuse from one source
// impractical while staying invisible to a real customer, who requests one
// code and occasionally one resend.
const shopOtpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many OTP requests — please wait a few minutes and try again." },
});

donorAuthRouter.post("/send-otp", otpRateLimit, donorAuthController.sendOtp);
donorAuthRouter.post("/shop/send-otp", shopOtpRateLimit, donorAuthController.sendShopOtp);
// Verification is shared: once a record exists, a shop customer and a donor
// are the same kind of session, proven the same way.
donorAuthRouter.post("/verify-otp", verifyRateLimit, donorAuthController.verifyOtp);

module.exports = { donorAuthRouter };
