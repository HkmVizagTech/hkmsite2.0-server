const express = require("express");
const { ekadashiCampaignController } = require("../controllers/ekadashiCampaign.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const ekadashiCampaignRouter = express.Router();

// Public — returns merged config so the /ekadashi page always has data
ekadashiCampaignRouter.get("/", ekadashiCampaignController.get);

// Admin — fetch raw config for the editor
ekadashiCampaignRouter.get("/config", authMiddleware, adminMiddleware, ekadashiCampaignController.getConfig);

// Admin — upsert config
ekadashiCampaignRouter.put("/", authMiddleware, adminMiddleware, ekadashiCampaignController.update);

module.exports = { ekadashiCampaignRouter };
