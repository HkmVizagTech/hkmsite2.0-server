const express = require("express");
const { devoteeController } = require("../controllers/devotee.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const devoteeRouter = express.Router();

devoteeRouter.get("/", authMiddleware, adminMiddleware, devoteeController.list);

module.exports = { devoteeRouter };
