const express = require("express");
const { siteContentController } = require("../controllers/siteContent.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const siteContentRouter = express.Router();

siteContentRouter.get("/", siteContentController.get); // public
siteContentRouter.put("/", authMiddleware, adminMiddleware, siteContentController.update);

module.exports = { siteContentRouter };
