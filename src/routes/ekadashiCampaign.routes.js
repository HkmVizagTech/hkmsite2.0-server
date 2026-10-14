import express from "express";
import { ekadashiCampaignController } from "../controllers/ekadashiCampaign.controller.js";

const ekadashiCampaignRouter = express.Router();

// Public — the fixed campaign content for the /ekadashi page.
// Admin edit routes were removed: /ekadashi is a permanent, common page.
ekadashiCampaignRouter.get("/", ekadashiCampaignController.get);

export { ekadashiCampaignRouter };
