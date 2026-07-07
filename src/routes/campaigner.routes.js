const express = require("express");
const { campaignerController } = require("../controllers/campaigner.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const campaignerRouter = express.Router();

campaignerRouter.post("/register", campaignerController.register); // public
campaignerRouter.get("/admin/list", authMiddleware, adminMiddleware, campaignerController.list);
campaignerRouter.put("/admin/:id/status", authMiddleware, adminMiddleware, campaignerController.updateStatus);
campaignerRouter.get("/:slug", campaignerController.getBySlug); // public — keep last (wildcard)

module.exports = { campaignerRouter };
