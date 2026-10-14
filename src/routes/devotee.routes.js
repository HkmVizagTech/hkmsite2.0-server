import express from "express";
import { devoteeController } from "../controllers/devotee.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const devoteeRouter = express.Router();

devoteeRouter.get("/", authMiddleware, adminMiddleware, devoteeController.list);

export { devoteeRouter };