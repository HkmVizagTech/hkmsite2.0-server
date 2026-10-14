import express from "express";
import { donorIssueAdminController } from "../controllers/donorIssueAdmin.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const donorIssueAdminRouter = express.Router();

donorIssueAdminRouter.get("/", authMiddleware, adminMiddleware, donorIssueAdminController.list);
donorIssueAdminRouter.put("/:id", authMiddleware, adminMiddleware, donorIssueAdminController.respond);

export { donorIssueAdminRouter };
