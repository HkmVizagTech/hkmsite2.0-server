import express from "express";
import rateLimit from "express-rate-limit";
import { userController } from "../controllers/user.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const userRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in a few minutes." },
});

userRouter.post("/register", authMiddleware, adminMiddleware, userController.register);
userRouter.post("/register-admin", authMiddleware, adminMiddleware, userController.registerAdmin);
userRouter.post("/login", loginLimiter, userController.login);
userRouter.post("/logout", userController.logout);
userRouter.put("/change-password", authMiddleware, userController.changePassword);

userRouter.get("/profile", authMiddleware, userController.profile);
userRouter.put("/update", authMiddleware, userController.update);

userRouter.get("/", authMiddleware, adminMiddleware, userController.getUser);
userRouter.delete("/:id", authMiddleware, adminMiddleware, userController.delete);

export { userRouter };
