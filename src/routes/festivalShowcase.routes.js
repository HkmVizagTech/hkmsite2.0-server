import express from "express";
import { festivalShowcaseController } from "../controllers/festivalShowcase.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const festivalShowcaseRouter = express.Router();

festivalShowcaseRouter.get("/public", festivalShowcaseController.publicList);
festivalShowcaseRouter.get("/:slug", festivalShowcaseController.getBySlug);

festivalShowcaseRouter.get("/", authMiddleware, adminMiddleware, festivalShowcaseController.list);
festivalShowcaseRouter.post("/", authMiddleware, adminMiddleware, festivalShowcaseController.create);
festivalShowcaseRouter.put("/:id", authMiddleware, adminMiddleware, festivalShowcaseController.update);
festivalShowcaseRouter.delete("/:id", authMiddleware, adminMiddleware, festivalShowcaseController.delete);

export { festivalShowcaseRouter };
