const express = require("express");
const { dashboardController } = require("../controllers/dashboard.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const dashboardRouter = express.Router();

dashboardRouter.get("/stats", authMiddleware, adminMiddleware, dashboardController.stats);

module.exports = { dashboardRouter };
