const express = require("express");
const { heroBannerController } = require("../controllers/heroBanner.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");
const upload = require("../utils/multer");

const heroBannerRouter = express.Router();

heroBannerRouter.get("/", heroBannerController.list); // public
heroBannerRouter.post("/", authMiddleware, adminMiddleware, upload.any(), heroBannerController.create);
heroBannerRouter.put("/reorder", authMiddleware, adminMiddleware, heroBannerController.reorder);
heroBannerRouter.put("/:id", authMiddleware, adminMiddleware, upload.any(), heroBannerController.update);
heroBannerRouter.delete("/:id", authMiddleware, adminMiddleware, heroBannerController.delete);

module.exports = { heroBannerRouter };
