const express = require("express");
const { sevaStatsController } = require("../controllers/sevaStats.controller");

const sevaStatsRouter = express.Router();

sevaStatsRouter.get("/", sevaStatsController.get); // public

module.exports = { sevaStatsRouter };
