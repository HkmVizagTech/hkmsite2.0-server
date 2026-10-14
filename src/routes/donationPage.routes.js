import express from "express";
import { donationPageController } from "../controllers/donationPage.controller.js";
import { authMiddleware, donationsAdminMiddleware } from "../middlewares/auth.middleware.js";

const donationPageRouter = express.Router();

donationPageRouter.get("/", donationPageController.get);
donationPageRouter.put("/", authMiddleware, donationsAdminMiddleware, donationPageController.update);

export { donationPageRouter };
