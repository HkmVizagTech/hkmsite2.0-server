import express from "express";
import { heroBannerController } from "../controllers/heroBanner.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";
import upload from "../utils/multer.js";

const heroBannerRouter = express.Router();

heroBannerRouter.get("/", heroBannerController.list); // public
heroBannerRouter.post("/", authMiddleware, adminMiddleware, upload.any(), heroBannerController.create);
heroBannerRouter.put("/reorder", authMiddleware, adminMiddleware, heroBannerController.reorder);
heroBannerRouter.put("/:id", authMiddleware, adminMiddleware, upload.any(), heroBannerController.update);
heroBannerRouter.delete("/:id", authMiddleware, adminMiddleware, heroBannerController.delete);

export { heroBannerRouter };