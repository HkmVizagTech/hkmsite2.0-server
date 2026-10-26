import express from "express";
import { donationController } from "../controllers/donation.controller.js";
import { upiFallbackController } from "../controllers/upiFallback.controller.js";
import { paymentFailuresController } from "../controllers/paymentFailures.controller.js";
import { subscriptionsAdminController } from "../controllers/subscriptionsAdmin.controller.js";
import { authMiddleware, adminMiddleware, preacherModuleMiddleware } from "../middlewares/auth.middleware.js";

const donationRouter = express.Router();

donationRouter.post("/", authMiddleware, adminMiddleware, donationController.create);

donationRouter.get("/", authMiddleware, adminMiddleware, donationController.list);
donationRouter.post(
  "/manual",
  authMiddleware,
  preacherModuleMiddleware("raise-receipt"),
  donationController.createManual
);
donationRouter.get("/stats", authMiddleware, adminMiddleware, donationController.stats);
donationRouter.get("/audit-pending", authMiddleware, adminMiddleware, donationController.auditPending);
donationRouter.get("/utm-stats", authMiddleware, adminMiddleware, donationController.getUtmStats);
donationRouter.get("/utm-transactions", authMiddleware, adminMiddleware, donationController.getUtmTransactions);
donationRouter.get("/report", authMiddleware, adminMiddleware, donationController.getReport);
donationRouter.get("/whatsapp-audit", authMiddleware, adminMiddleware, donationController.whatsappAudit);
donationRouter.get("/needs-manual-receipt", authMiddleware, adminMiddleware, donationController.needsManualReceipt);
// Monthly seva subscriptions (Admin → Donations → Monthly Seva). Above /:id.
donationRouter.get("/subscriptions", authMiddleware, adminMiddleware, subscriptionsAdminController.list);
// DCC receipts panel (Admin → Donations → DCC receipts). Above /:id.
donationRouter.get("/dcc-status", authMiddleware, adminMiddleware, donationController.dccStatus);
donationRouter.post("/dcc-push-all", authMiddleware, adminMiddleware, donationController.dccPushAll);
donationRouter.post(
  "/backfill-dcc-donor-numbers",
  authMiddleware,
  adminMiddleware,
  donationController.backfillDccDonorNumbers
);
donationRouter.get("/needs-whatsapp", authMiddleware, adminMiddleware, donationController.needsWhatsApp);
donationRouter.post("/backfill-donors", authMiddleware, adminMiddleware, donationController.backfillDonors);
// Bulk resend for a window of receipts that never went out (provider outage).
// Declared before the "/:id/..." routes so it can never be read as an id.
donationRouter.post(
  "/resend-recent-whatsapp",
  authMiddleware,
  adminMiddleware,
  donationController.resendRecentWhatsApp
);
donationRouter.get("/prasadam-requests", authMiddleware, adminMiddleware, donationController.listPrasadamRequests);
donationRouter.get("/prasadam-export", authMiddleware, adminMiddleware, donationController.exportPrasadamCsv);
donationRouter.put("/:id/prasadam-status", authMiddleware, adminMiddleware, donationController.updatePrasadamStatus);
// Why website payments fail (Admin → Donations → Payment failures). Above /:id.
donationRouter.get("/payment-failures", authMiddleware, adminMiddleware, paymentFailuresController.summary);
// UPI fallback claims (Admin → Donations → UPI to match). Must stay above /:id.
donationRouter.get("/upi-claims", authMiddleware, adminMiddleware, upiFallbackController.listClaims);
donationRouter.get("/upi-claims/:id/candidates", authMiddleware, adminMiddleware, upiFallbackController.candidates);
donationRouter.get("/upi-qr-payments", authMiddleware, adminMiddleware, upiFallbackController.qrPayments);
donationRouter.post("/upi-match", authMiddleware, adminMiddleware, upiFallbackController.match);
donationRouter.post("/upi-dismiss", authMiddleware, adminMiddleware, upiFallbackController.dismiss);
donationRouter.get("/:id", authMiddleware, adminMiddleware, donationController.get);
donationRouter.post("/:id/resend-receipt", authMiddleware, adminMiddleware, donationController.resendReceipt);
donationRouter.put("/:id/receipt-number", authMiddleware, adminMiddleware, donationController.patchReceiptNumber);
donationRouter.post("/:id/resend-whatsapp", authMiddleware, adminMiddleware, donationController.resendWhatsApp);
donationRouter.put("/:id/manual-complete", authMiddleware, adminMiddleware, donationController.completeManualPending);
donationRouter.put("/:id", authMiddleware, adminMiddleware, donationController.update);
donationRouter.delete("/:id", authMiddleware, adminMiddleware, donationController.delete);

export { donationRouter };
