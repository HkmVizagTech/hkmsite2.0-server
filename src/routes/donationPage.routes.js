const express = require("express");
const { donationPageController } = require("../controllers/donationPage.controller");
const { authMiddleware, donationsAdminMiddleware } = require("../middlewares/auth.middleware");

const donationPageRouter = express.Router();

donationPageRouter.get("/", donationPageController.get);
donationPageRouter.put("/", authMiddleware, donationsAdminMiddleware, donationPageController.update);

module.exports = { donationPageRouter };
