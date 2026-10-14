import express from "express";
import { dashboardController } from "../controllers/dashboard.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const dashboardRouter = express.Router();

dashboardRouter.get("/stats", authMiddleware, adminMiddleware, dashboardController.stats);

export { dashboardRouter };