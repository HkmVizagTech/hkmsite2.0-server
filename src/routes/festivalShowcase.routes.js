const express = require("express");
const { festivalShowcaseController } = require("../controllers/festivalShowcase.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const festivalShowcaseRouter = express.Router();

festivalShowcaseRouter.get("/public", festivalShowcaseController.publicList);
festivalShowcaseRouter.get("/:slug", festivalShowcaseController.getBySlug);

festivalShowcaseRouter.get("/", authMiddleware, adminMiddleware, festivalShowcaseController.list);
festivalShowcaseRouter.post("/", authMiddleware, adminMiddleware, festivalShowcaseController.create);
festivalShowcaseRouter.put("/:id", authMiddleware, adminMiddleware, festivalShowcaseController.update);
festivalShowcaseRouter.delete("/:id", authMiddleware, adminMiddleware, festivalShowcaseController.delete);

module.exports = { festivalShowcaseRouter };