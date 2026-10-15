const express = require("express");
const { donationAdminController } = require("../controllers/donationAdmin.controller");
const { authMiddleware, donationsAdminMiddleware } = require("../middlewares/auth.middleware");
const upload = require("../utils/multer");

const donationAdminRouter = express.Router();

// Every route here is scoped to the standalone /donations page's own data
// and requires an authenticated admin — same protection pattern as the
// rest of the admin API.
donationAdminRouter.get("/dashboard-stats", authMiddleware, donationsAdminMiddleware, donationAdminController.getDashboardStats);
donationAdminRouter.get("/report", authMiddleware, donationsAdminMiddleware, donationAdminController.getReport);
donationAdminRouter.get("/transactions", authMiddleware, donationsAdminMiddleware, donationAdminController.getAllTransactions);
donationAdminRouter.get("/transactions/:id", authMiddleware, donationsAdminMiddleware, donationAdminController.getTransactionById);
// DCC receipts (push to DCC, receipt number, WhatsApp receipt) for this page's donations.
donationAdminRouter.get("/dcc-status", authMiddleware, donationsAdminMiddleware, donationAdminController.dccStatus);
donationAdminRouter.post("/dcc-push-all", authMiddleware, donationsAdminMiddleware, donationAdminController.dccPushAll);
donationAdminRouter.post("/transactions/:id/dcc-push", authMiddleware, donationsAdminMiddleware, donationAdminController.dccPushOne);
donationAdminRouter.put("/transactions/:id/receipt-number", authMiddleware, donationsAdminMiddleware, donationAdminController.setReceiptNumber);
donationAdminRouter.get("/utm-stats", authMiddleware, donationsAdminMiddleware, donationAdminController.getUtmStats);
donationAdminRouter.get("/utm-transactions", authMiddleware, donationsAdminMiddleware, donationAdminController.getUtmTransactions);
donationAdminRouter.get("/export", authMiddleware, donationsAdminMiddleware, donationAdminController.exportTransactions);
donationAdminRouter.get("/diagnose-order", authMiddleware, donationsAdminMiddleware, donationAdminController.diagnoseOrder);
donationAdminRouter.post("/manual-complete", authMiddleware, donationsAdminMiddleware, donationAdminController.manualComplete);
donationAdminRouter.post("/reconcile-pending", authMiddleware, donationsAdminMiddleware, donationAdminController.reconcilePending);
// Maha Prasadam dispatch tracking — per donation, this page's donations only.
donationAdminRouter.get("/prasadam-requests", authMiddleware, donationsAdminMiddleware, donationAdminController.listPrasadamRequests);
donationAdminRouter.get("/prasadam-export", authMiddleware, donationsAdminMiddleware, donationAdminController.exportPrasadamCsv);
donationAdminRouter.put("/transactions/:id/prasadam-status", authMiddleware, donationsAdminMiddleware, donationAdminController.updatePrasadamStatus);
donationAdminRouter.post("/upload-image", authMiddleware, donationsAdminMiddleware, upload.single("file"), donationAdminController.uploadImage);

module.exports = { donationAdminRouter };
