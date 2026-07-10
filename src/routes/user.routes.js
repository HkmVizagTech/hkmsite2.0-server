


const express = require("express");
const rateLimit = require("express-rate-limit");
const { userController } = require("../controllers/user.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const userRouter = express.Router();

// Brute-force protection: 10 attempts per 15 minutes per IP. Counts only
// failed/all requests to this route — legitimate users log in once and
// won't notice; credential-stuffing scripts get slowed to a crawl.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in a few minutes." },
});

// Registration creates backoffice staff/admin accounts — this must never
// be public on a live site. Only an already-authenticated admin can invite
// a new user. (Public donor/campaigner flows are separate: /campaigners/register.)
userRouter.post("/register", authMiddleware, adminMiddleware, userController.register);
userRouter.post("/login", loginLimiter, userController.login);
userRouter.post("/logout", userController.logout);

userRouter.get("/profile", authMiddleware, userController.profile);
userRouter.put("/update", authMiddleware, userController.update);

userRouter.get("/", authMiddleware, adminMiddleware, userController.getUser);
userRouter.delete("/:id", authMiddleware, adminMiddleware, userController.delete);

module.exports = { userRouter };