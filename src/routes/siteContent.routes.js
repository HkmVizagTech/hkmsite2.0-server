import express from "express";
import { siteContentController } from "../controllers/siteContent.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const siteContentRouter = express.Router();

siteContentRouter.get("/", siteContentController.get); // public
siteContentRouter.put("/", authMiddleware, adminMiddleware, siteContentController.update);

export { siteContentRouter };
