const express = require("express");
const { galleryController } = require("../controllers/gallery.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");
const upload = require("../utils/multer");

const galleryRouter = express.Router();

galleryRouter.get("/", galleryController.list);
galleryRouter.get("/:id", galleryController.get);

// Upload a single image to R2 — returns { secure_url } so the admin can
// collect URLs before creating the gallery entry. Same pattern as the
// media library, donations page, and hero banner upload endpoints.
galleryRouter.post("/upload-image", authMiddleware, adminMiddleware, upload.single("file"), galleryController.uploadImage);

galleryRouter.post("/", authMiddleware, adminMiddleware, express.json(), galleryController.create);
galleryRouter.put("/:id", authMiddleware, adminMiddleware, express.json(), galleryController.update);
galleryRouter.delete("/:id", authMiddleware, adminMiddleware, galleryController.delete);

module.exports = { galleryRouter };
