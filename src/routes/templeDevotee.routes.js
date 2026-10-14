import express from "express";
import { templeDevoteeController } from "../controllers/templeDevotee.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const templeDevoteeRouter = express.Router();

templeDevoteeRouter.get("/", templeDevoteeController.publicList); // public — dropdown for campaigner registration
templeDevoteeRouter.get("/admin/list", authMiddleware, adminMiddleware, templeDevoteeController.adminList);
templeDevoteeRouter.post("/admin", authMiddleware, adminMiddleware, templeDevoteeController.create);
templeDevoteeRouter.put("/admin/:id", authMiddleware, adminMiddleware, templeDevoteeController.update);

export { templeDevoteeRouter };
