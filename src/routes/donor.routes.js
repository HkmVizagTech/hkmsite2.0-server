import express from "express";
import { donorController } from "../controllers/donor.controller.js";
import { donorAuthMiddleware } from "../middlewares/auth.middleware.js";

const donorRouter = express.Router();

donorRouter.get("/me", donorAuthMiddleware, donorController.me);
donorRouter.patch("/me", donorAuthMiddleware, donorController.updateProfile);
donorRouter.get("/my-donations", donorAuthMiddleware, donorController.myDonations);
donorRouter.get("/stats", donorAuthMiddleware, donorController.stats);
donorRouter.get("/subscriptions", donorAuthMiddleware, donorController.subscriptions);
donorRouter.post("/subscriptions/:subscriptionId/cancel", donorAuthMiddleware, donorController.cancelSubscription);
donorRouter.get("/my-summary", donorAuthMiddleware, donorController.mySummary);
donorRouter.get("/receipt/:donationId", donorAuthMiddleware, donorController.downloadReceipt);
donorRouter.post("/issues", donorAuthMiddleware, donorController.raiseIssue);
donorRouter.get("/issues", donorAuthMiddleware, donorController.myIssues);

export { donorRouter };
