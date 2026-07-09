const express = require("express");
const { sevaStatsController } = require("../controllers/sevaStats.controller");

const sevaStatsRouter = express.Router();

sevaStatsRouter.get("/sqft-campaign", sevaStatsController.sqftCampaign); // public
sevaStatsRouter.get("/overview", sevaStatsController.overview); // public
sevaStatsRouter.get("/", sevaStatsController.get); // public

module.exports = { sevaStatsRouter };
