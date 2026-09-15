const express = require("express");
const { donorIssueAdminController } = require("../controllers/donorIssueAdmin.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const donorIssueAdminRouter = express.Router();

donorIssueAdminRouter.get("/", authMiddleware, adminMiddleware, donorIssueAdminController.list);
donorIssueAdminRouter.put("/:id", authMiddleware, adminMiddleware, donorIssueAdminController.respond);

module.exports = { donorIssueAdminRouter };
