const express = require("express");
const { donorController } = require("../controllers/donor.controller");
const { donorAuthMiddleware } = require("../middlewares/auth.middleware");

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

module.exports = { donorRouter };
