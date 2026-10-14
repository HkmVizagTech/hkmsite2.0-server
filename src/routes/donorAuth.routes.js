import express from "express";
import rateLimit from "express-rate-limit";
import { donorAuthController } from "../controllers/donorAuth.controller.js";

const donorAuthRouter = express.Router();

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

const shopOtpRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many OTP requests — please wait a few minutes and try again." },
});

donorAuthRouter.post("/send-otp", otpRateLimit, donorAuthController.sendOtp);
donorAuthRouter.post("/shop/send-otp", shopOtpRateLimit, donorAuthController.sendShopOtp);
donorAuthRouter.post("/lookup", (req, res) =>
  res.status(410).json({ success: false, message: "This lookup is no longer available." })
);
// Verification is shared: once a record exists, a shop customer and a donor
// are the same kind of session, proven the same way.
donorAuthRouter.post("/verify-otp", verifyRateLimit, donorAuthController.verifyOtp);

export { donorAuthRouter };
