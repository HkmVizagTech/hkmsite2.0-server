import express from "express";
import { festivalDonationController } from "../controllers/festivalDonation.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const festivalDonationRouter = express.Router();

festivalDonationRouter.get("/all", festivalDonationController.publicList);
festivalDonationRouter.get("/:slug", festivalDonationController.getBySlug);

festivalDonationRouter.get("/", authMiddleware, adminMiddleware, festivalDonationController.list);
festivalDonationRouter.post("/", authMiddleware, adminMiddleware, festivalDonationController.create);
festivalDonationRouter.put("/:id", authMiddleware, adminMiddleware, festivalDonationController.update);
festivalDonationRouter.delete("/:id", authMiddleware, adminMiddleware, festivalDonationController.delete);

export { festivalDonationRouter };
