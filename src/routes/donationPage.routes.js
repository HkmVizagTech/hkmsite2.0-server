const express = require("express");
const { donationPageController } = require("../controllers/donationPage.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const donationPageRouter = express.Router();

donationPageRouter.get("/", donationPageController.get);
donationPageRouter.put("/", authMiddleware, adminMiddleware, donationPageController.update);

module.exports = { donationPageRouter };
