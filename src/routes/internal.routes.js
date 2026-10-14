import express from "express";
import { internalAuth } from "../middlewares/internalAuth.middleware.js";
import { internalController } from "../controllers/internal.controller.js";

const internalRouter = express.Router();

internalRouter.use(internalAuth);

// Order matters: the literal /donors list must be registered before the
// /donors/by-mobile/:mobile pattern so it isn't swallowed by it.
internalRouter.get("/donors", internalController.listDonors);
internalRouter.get("/donors/by-mobile/:mobile", internalController.getDonorByMobile);
// A profile correction made in DRM, pushed back here. Updates the donor record
// only - past donations keep the name and address their receipts were issued
// with, so an issued 80G receipt never disagrees with the record behind it.
internalRouter.put("/donors/by-mobile/:mobile/profile", internalController.updateDonorProfile);
// Offline donation entered in DRM. Delegates to the same "raise receipt" path
// a preacher uses on this site, so DCC, the receipt number and the WhatsApp
// send are all the existing ones. Declared before the "/donations/:id/..."
// patterns so "offline" is never read as an id.
internalRouter.post("/donations/offline", internalController.createOfflineDonation);

// Prasadam dispatch status set in DRM, pushed here so this site's Prasadam tab
// doesn't keep showing delivered boxes as pending. Read-modify-write on one
// donation's prasadam fields; nothing else on the record is touched, and it is
// idempotent - re-sending the same status is a no-op in effect.
internalRouter.put("/donations/:id/prasadam-status", internalController.updatePrasadamStatus);

// Donations started here and never completed, for DRM to turn into leads the
// temple can ring. Read-only; nothing on this site is changed by it.
internalRouter.get("/abandoned", internalController.getAbandonedDonations);

internalRouter.get("/donations/:id/receipt.pdf", internalController.getReceiptPdf);
internalRouter.post("/donations/:id/resend-receipt", internalController.resendReceipt);

export { internalRouter };