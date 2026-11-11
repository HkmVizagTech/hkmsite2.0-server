const express = require("express");
const rateLimit = require("express-rate-limit");
const { preacherPortalController: c, requirePreacher } = require("../controllers/preacherPortal.controller");

const preacherPortalRouter = express.Router();
const sendLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many code requests. Please wait a few minutes." } });
const verifyLimit = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many attempts. Please wait a moment." } });

preacherPortalRouter.post("/send-otp", sendLimit, c.sendOtp);
preacherPortalRouter.post("/verify-otp", verifyLimit, c.verifyOtp);
preacherPortalRouter.get("/dashboard", requirePreacher, c.dashboard);

module.exports = { preacherPortalRouter };
