import express from "express";
import { campaignerController } from "../controllers/campaigner.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const campaignerRouter = express.Router();

campaignerRouter.post("/register", campaignerController.register); // public
campaignerRouter.get("/admin/list", authMiddleware, adminMiddleware, campaignerController.list);
campaignerRouter.put("/admin/:id/status", authMiddleware, adminMiddleware, campaignerController.updateStatus);
campaignerRouter.get("/:slug", campaignerController.getBySlug); // public — keep last (wildcard)

export { campaignerRouter };
