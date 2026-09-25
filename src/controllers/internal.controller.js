const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");

const normalizeMobile = (m) => String(m || "").replace(/\s+/g, "").replace(/^\+?91/, "");

const internalController = {
  // GET /api/internal/donors/by-mobile/:mobile
  // Server-to-server snapshot for the HKM Vizag DRM (donor relationship
  // manager, a separate PostgreSQL/Express app) to sync a donor's identity,
  // donation/receipt history, recurring subscriptions, and prasadam
  // delivery status. Protected by x-internal-secret, the same convention
  // already used by the other /api/internal routes in app.js — this is a
  // service call, not a logged-in donor session, so donorAuthMiddleware
  // does not apply here.
  //
  // Recurring donations are collapsed into one entry per Razorpay
  // subscriptionId, same grouping donor.controller.js's own
  // GET /donor/subscriptions uses. Unlike that endpoint, this does NOT
  // call out to Razorpay for the live subscription status — DRM's sync is
  // meant to be cheap to run often, and a per-subscription Razorpay fetch
  // on every sync would not be. The locally-derived status (from the most
  // recent donation record for that subscription) is a fine approximation;
  // if that ever needs to be the authoritative live status, add a
  // `live=true` query flag here that opts into the same Razorpay lookup
  // donor.controller.js does.
  getDonorByMobile: async (req, res) => {
    try {
      const mobile = normalizeMobile(req.params.mobile);
      if (!mobile) {
        return res.status(400).json({ success: false, message: "Mobile number required" });
      }

      const donor = await donorModel.findOne({ mobile }).lean();
      if (!donor) return res.json({ success: true, found: false });

      const donations = await donationModel
        .find({ donorRecordId: donor._id })
        .sort({ createdAt: -1 })
        .select(
          [
            "amount",
            "sevaName",
            "type",
            "status",
            "createdAt",
            "isRecurring",
            "subscriptionId",
            "receiptNumber",
            "receiptGeneratedAt",
            "wantPrasadam",
            "prasadamStatus",
            "prasadamCourier",
            "prasadamTrackingNumber",
            "prasadamDispatchedAt",
            "prasadamDeliveredAt",
            "prasadamAddress",
          ].join(" ")
        )
        .lean();

      const bySubscription = new Map();
      for (const d of donations) {
        if (!d.isRecurring || !d.subscriptionId) continue;
        const key = d.subscriptionId;
        if (!bySubscription.has(key)) {
          bySubscription.set(key, {
            subscriptionId: key,
            sevaName: d.sevaName || d.type || "Monthly Seva",
            amount: d.amount,
            status: d.status,
            startedAt: d.createdAt,
            lastChargedAt: d.status === "completed" ? d.createdAt : null,
            chargeCount: d.status === "completed" ? 1 : 0,
          });
        } else {
          const entry = bySubscription.get(key);
          entry.amount = d.amount; // most recent charge amount wins (list is newest-first)
          if (d.status === "completed") {
            entry.chargeCount += 1;
            if (!entry.lastChargedAt || d.createdAt > entry.lastChargedAt) entry.lastChargedAt = d.createdAt;
          }
          if (d.createdAt < entry.startedAt) entry.startedAt = d.createdAt;
        }
      }

      res.json({
        success: true,
        found: true,
        donor: {
          externalId: String(donor._id),
          donorId: donor.dccDonorNumber || donor.donorId,
          name: donor.name,
          mobile: donor.mobile,
          email: donor.email || null,
          panNumber: donor.panNumber || null,
          savedAddress: donor.savedAddress || null,
          donorSince: donor.createdAt,
        },
        donations: donations.map((d) => ({
          externalId: String(d._id),
          amount: d.amount,
          type: d.sevaName || d.type || "General",
          status: d.status,
          createdAt: d.createdAt,
          isRecurring: !!d.isRecurring,
          subscriptionId: d.subscriptionId || null,
          receiptNumber: d.receiptNumber || null,
          receiptIssuedAt: d.receiptGeneratedAt || null,
          prasadam: d.wantPrasadam
            ? {
                status: d.prasadamStatus || "pending",
                courierName: d.prasadamCourier || null,
                trackingNumber: d.prasadamTrackingNumber || null,
                dispatchedAt: d.prasadamDispatchedAt || null,
                deliveredAt: d.prasadamDeliveredAt || null,
                address: d.prasadamAddress || null,
              }
            : null,
        })),
        subscriptions: Array.from(bySubscription.values()),
      });
    } catch (err) {
      console.error("internal.getDonorByMobile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /api/internal/donations/:id/receipt.pdf
  // Streams the same 80G receipt PDF a logged-in donor would get from
  // GET /donor/receipt/:donationId, so DRM can show/download the real
  // receipt instead of duplicating PDF generation on its own side.
  getReceiptPdf: async (req, res) => {
    try {
      const donation = await donationModel.findById(req.params.id);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });
      if (donation.status !== "completed" || !donation.receiptNumber) {
        return res.status(400).json({ success: false, message: "This donation doesn't have a receipt yet." });
      }

      const { generateReceiptBuffer } = require("../services/receipt.service");
      const pdfBytes = await generateReceiptBuffer(donation._id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="receipt-${donation.receiptNumber.replace(/\|/g, "-")}.pdf"`
      );
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("internal.getReceiptPdf error:", err);
      res.status(500).json({ success: false, message: "Could not generate receipt." });
    }
  },
};

module.exports = { internalController };
