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

internalRouter.get("/donors/by-mobile/:mobile", internalController.getDonorByMobile);
internalRouter.get("/donations/:id/receipt.pdf", internalController.getReceiptPdf);

module.exports = { internalRouter };
