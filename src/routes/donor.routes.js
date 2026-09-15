const express = require("express");
const { donorController } = require("../controllers/donor.controller");
const { donorAuthMiddleware } = require("../middlewares/auth.middleware");

const donorRouter = express.Router();

donorRouter.get("/me", donorAuthMiddleware, donorController.me);
donorRouter.get("/my-donations", donorAuthMiddleware, donorController.myDonations);
donorRouter.get("/my-summary", donorAuthMiddleware, donorController.mySummary);
donorRouter.get("/receipt/:donationId", donorAuthMiddleware, donorController.downloadReceipt);
donorRouter.post("/issues", donorAuthMiddleware, donorController.raiseIssue);
donorRouter.get("/issues", donorAuthMiddleware, donorController.myIssues);

module.exports = { donorRouter };
