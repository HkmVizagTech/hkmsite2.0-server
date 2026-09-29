const express = require("express");
const { internalController } = require("../controllers/internal.controller");

const internalRouter = express.Router();

// Shared-secret auth — same convention as the other /api/internal endpoints
// already defined in app.js (x-internal-secret checked against
// process.env.INTERNAL_SECRET). Server-to-server only, never called from a
// browser. Currently used by the HKM Vizag DRM (donor relationship manager,
// D:\projects\drm) to sync donor identity, donation/receipt history,
// recurring subscriptions, and prasadam delivery status.
internalRouter.use((req, res, next) => {
  if (!process.env.INTERNAL_SECRET || req.headers["x-internal-secret"] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
});

// Order matters: the literal /donors list must be registered before the
// /donors/by-mobile/:mobile pattern so it isn't swallowed by it.
internalRouter.get("/donors", internalController.listDonors);
internalRouter.get("/donors/by-mobile/:mobile", internalController.getDonorByMobile);
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

module.exports = { internalRouter };
