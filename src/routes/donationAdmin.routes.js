import express from "express";
import { donationAdminController } from "../controllers/donationAdmin.controller.js";
import { authMiddleware, donationsAdminMiddleware } from "../middlewares/auth.middleware.js";
import upload from "../utils/multer.js";

const donationAdminRouter = express.Router();

donationAdminRouter.get(
  "/dashboard-stats",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.getDashboardStats
);
donationAdminRouter.get("/report", authMiddleware, donationsAdminMiddleware, donationAdminController.getReport);
donationAdminRouter.get(
  "/transactions",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.getAllTransactions
);
donationAdminRouter.get(
  "/transactions/:id",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.getTransactionById
);
// DCC receipts (push to DCC, receipt number, WhatsApp receipt) for this page's donations.
donationAdminRouter.get("/dcc-status", authMiddleware, donationsAdminMiddleware, donationAdminController.dccStatus);
donationAdminRouter.post("/dcc-push-all", authMiddleware, donationsAdminMiddleware, donationAdminController.dccPushAll);
donationAdminRouter.post(
  "/transactions/:id/dcc-push",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.dccPushOne
);
donationAdminRouter.put(
  "/transactions/:id/receipt-number",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.setReceiptNumber
);
donationAdminRouter.get("/utm-stats", authMiddleware, donationsAdminMiddleware, donationAdminController.getUtmStats);
donationAdminRouter.get(
  "/utm-transactions",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.getUtmTransactions
);
donationAdminRouter.get(
  "/export",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.exportTransactions
);
donationAdminRouter.get(
  "/diagnose-order",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.diagnoseOrder
);
donationAdminRouter.post(
  "/manual-complete",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.manualComplete
);
donationAdminRouter.post(
  "/reconcile-pending",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.reconcilePending
);
donationAdminRouter.get(
  "/prasadam-requests",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.listPrasadamRequests
);
donationAdminRouter.get(
  "/prasadam-export",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.exportPrasadamCsv
);
donationAdminRouter.put(
  "/transactions/:id/prasadam-status",
  authMiddleware,
  donationsAdminMiddleware,
  donationAdminController.updatePrasadamStatus
);
donationAdminRouter.post(
  "/upload-image",
  authMiddleware,
  donationsAdminMiddleware,
  upload.single("file"),
  donationAdminController.uploadImage
);

export { donationAdminRouter };
