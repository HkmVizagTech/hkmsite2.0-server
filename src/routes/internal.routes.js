import express from "express";
import { internalAuth } from "../middlewares/internalAuth.middleware.js";
import { internalController } from "../controllers/internal.controller.js";

const internalRouter = express.Router();

internalRouter.use(internalAuth);

// Order matters: the literal /donors list must be registered before the
// /donors/by-mobile/:mobile pattern so it isn't swallowed by it.
internalRouter.get("/donors", internalController.listDonors);
internalRouter.get("/donors/by-mobile/:mobile", internalController.getDonorByMobile);
internalRouter.put("/donors/by-mobile/:mobile/profile", internalController.updateDonorProfile);
internalRouter.post("/donations/offline", internalController.createOfflineDonation);

internalRouter.put("/donations/:id/prasadam-status", internalController.updatePrasadamStatus);

// Donations started here and never completed, for DRM to turn into leads the
// temple can ring. Read-only; nothing on this site is changed by it.
internalRouter.get("/abandoned", internalController.getAbandonedDonations);

internalRouter.get("/donations/:id/receipt.pdf", internalController.getReceiptPdf);
internalRouter.post("/donations/:id/resend-receipt", internalController.resendReceipt);

export { internalRouter };
