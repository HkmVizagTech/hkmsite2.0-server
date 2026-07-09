const express = require("express");
const { mediaController } = require("../controllers/media.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");
const upload = require("../utils/multer");

const mediaRouter = express.Router();

mediaRouter.get("/", authMiddleware, adminMiddleware, mediaController.list);
mediaRouter.post("/", authMiddleware, adminMiddleware, upload.any(), mediaController.upload);
mediaRouter.put("/:id", authMiddleware, adminMiddleware, mediaController.update);
mediaRouter.delete("/:id", authMiddleware, adminMiddleware, mediaController.delete);

module.exports = { mediaRouter };
