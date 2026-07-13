const express = require("express");
const { donationAdminController } = require("../controllers/donationAdmin.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const donationAdminRouter = express.Router();

// Every route here is scoped to the standalone /donations page's own data
// and requires an authenticated admin — same protection pattern as the
// rest of the admin API.
donationAdminRouter.get("/dashboard-stats", authMiddleware, adminMiddleware, donationAdminController.getDashboardStats);
donationAdminRouter.get("/transactions", authMiddleware, adminMiddleware, donationAdminController.getAllTransactions);
donationAdminRouter.get("/transactions/:id", authMiddleware, adminMiddleware, donationAdminController.getTransactionById);
donationAdminRouter.get("/utm-stats", authMiddleware, adminMiddleware, donationAdminController.getUtmStats);
donationAdminRouter.get("/utm-transactions", authMiddleware, adminMiddleware, donationAdminController.getUtmTransactions);
donationAdminRouter.get("/export", authMiddleware, adminMiddleware, donationAdminController.exportTransactions);

module.exports = { donationAdminRouter };
