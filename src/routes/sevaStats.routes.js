import express from "express";
import { sevaStatsController } from "../controllers/sevaStats.controller.js";

const sevaStatsRouter = express.Router();

sevaStatsRouter.get("/sqft-campaign", sevaStatsController.sqftCampaign); // public
sevaStatsRouter.get("/overview", sevaStatsController.overview); // public
sevaStatsRouter.get("/", sevaStatsController.get); // public

export { sevaStatsRouter };