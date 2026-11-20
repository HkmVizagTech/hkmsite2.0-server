const express = require("express");
const rateLimit = require("express-rate-limit");
const { devoteePortalController: c } = require("../controllers/devoteePortal.controller");

const devoteePortalRouter = express.Router();
const sendLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many code requests. Please wait a few minutes." } });
const verifyLimit = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many attempts. Please wait a moment." } });

devoteePortalRouter.post("/send-otp", sendLimit, c.sendOtp);
devoteePortalRouter.post("/verify-otp", verifyLimit, c.verifyOtp);

module.exports = { devoteePortalRouter };
