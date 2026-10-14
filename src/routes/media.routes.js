import express from "express";
import { mediaController } from "../controllers/media.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";
import upload from "../utils/multer.js";

const mediaRouter = express.Router();

mediaRouter.get("/", authMiddleware, adminMiddleware, mediaController.list);
mediaRouter.post("/", authMiddleware, adminMiddleware, upload.any(), mediaController.upload);
mediaRouter.put("/:id", authMiddleware, adminMiddleware, mediaController.update);
mediaRouter.delete("/:id", authMiddleware, adminMiddleware, mediaController.delete);

export { mediaRouter };