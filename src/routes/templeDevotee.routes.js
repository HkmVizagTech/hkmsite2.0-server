const express = require("express");
const { templeDevoteeController } = require("../controllers/templeDevotee.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const templeDevoteeRouter = express.Router();

templeDevoteeRouter.get("/", templeDevoteeController.publicList); // public — dropdown for campaigner registration
templeDevoteeRouter.get("/admin/list", authMiddleware, adminMiddleware, templeDevoteeController.adminList);
templeDevoteeRouter.post("/admin", authMiddleware, adminMiddleware, templeDevoteeController.create);
templeDevoteeRouter.put("/admin/:id", authMiddleware, adminMiddleware, templeDevoteeController.update);

module.exports = { templeDevoteeRouter };
