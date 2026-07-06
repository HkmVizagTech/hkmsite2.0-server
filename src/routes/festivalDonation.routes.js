const express = require("express");
const { festivalDonationController } = require("../controllers/festivalDonation.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const festivalDonationRouter = express.Router();

	festivalDonationRouter.get("/all", festivalDonationController.publicList);
	festivalDonationRouter.get("/:slug", festivalDonationController.getBySlug);

festivalDonationRouter.get("/", authMiddleware, adminMiddleware, festivalDonationController.list);
festivalDonationRouter.post("/", authMiddleware, adminMiddleware, festivalDonationController.create);
festivalDonationRouter.put("/:id", authMiddleware, adminMiddleware, festivalDonationController.update);
festivalDonationRouter.delete("/:id", authMiddleware, adminMiddleware, festivalDonationController.delete);

module.exports = { festivalDonationRouter };
