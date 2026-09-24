const express = require("express");
const { ekadashiCampaignController } = require("../controllers/ekadashiCampaign.controller");

const ekadashiCampaignRouter = express.Router();

// Public — the fixed campaign content for the /ekadashi page.
// Admin edit routes were removed: /ekadashi is a permanent, common page.
ekadashiCampaignRouter.get("/", ekadashiCampaignController.get);

module.exports = { ekadashiCampaignRouter };