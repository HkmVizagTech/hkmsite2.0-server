const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");

const normalizeMobile = (m) => String(m || "").replace(/\s+/g, "").replace(/^\+?91/, "");

// Fields DRM needs from a donation. Kept in one place so the by-mobile
// endpoint, the paginated backfill list, and the live push to DRM can never
// drift apart on what they select.
const DONATION_FIELDS = [
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
  "donorRecordId",
].join(" ");

function mapDonation(d) {
  return {
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
  };
}

function mapDonor(donor) {
  return {
    externalId: String(donor._id),
    donorId: donor.dccDonorNumber || donor.donorId,
    name: donor.name,
    mobile: donor.mobile,
    email: donor.email || null,
    panNumber: donor.panNumber || null,
    savedAddress: donor.savedAddress || null,
    donorSince: donor.createdAt,
  };
}

// Collapse recurring donations into one entry per Razorpay subscriptionId -
// the same grouping donor.controller.js's GET /donor/subscriptions uses.
// `donations` must be sorted newest-first.
function collapseSubscriptions(donations) {
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
  return Array.from(bySubscription.values());
}

// Builds the donor snapshot payload DRM consumes. Exported because
// drmNotify.service.js pushes this exact same shape to DRM the moment a
// donation completes - so DRM has ONE idempotent upsert path that handles
// both the pull (sync/backfill) and the push (live webhook) identically.
async function buildDonorSnapshot(donor) {
  const donations = await donationModel
    .find({ donorRecordId: donor._id })
    .sort({ createdAt: -1 })
    .select(DONATION_FIELDS)
    .lean();

  return {
    donor: mapDonor(donor),
    donations: donations.map(mapDonation),
    subscriptions: collapseSubscriptions(donations),
  };
}

// Batch version for the backfill list: one donations query for the whole
// page instead of one per donor, so importing thousands of donors doesn't
// turn into thousands of round trips.
async function buildDonorSnapshots(donors) {
  if (!donors.length) return [];
  const ids = donors.map((d) => d._id);

  const donations = await donationModel
    .find({ donorRecordId: { $in: ids } })
    .sort({ createdAt: -1 })
    .select(DONATION_FIELDS)
    .lean();

  const byDonor = new Map();
  for (const d of donations) {
    const key = String(d.donorRecordId);
    if (!byDonor.has(key)) byDonor.set(key, []);
    byDonor.get(key).push(d);
  }

  return donors.map((donor) => {
    const own = byDonor.get(String(donor._id)) || [];
    return {
      donor: mapDonor(donor),
      donations: own.map(mapDonation),
      subscriptions: collapseSubscriptions(own),
    };
  });
}

const internalController = {
  // GET /api/internal/donors/by-mobile/:mobile
  // Server-to-server snapshot for the HKM Vizag DRM (donor relationship
  // manager, a separate PostgreSQL/Express app) to sync a donor's identity,
  // donation/receipt history, recurring subscriptions, and prasadam
  // delivery status. Protected by x-internal-secret, the same convention
  // already used by the other /api/internal routes in app.js - this is a
  // service call, not a logged-in donor session, so donorAuthMiddleware
  // does not apply here.
  //
  // Note this does NOT call out to Razorpay for live subscription status -
  // DRM's sync is meant to be cheap to run often. The locally-derived
  // status (from the most recent donation for that subscription) is a fine
  // approximation; if it ever needs to be authoritative, add a `live=true`
  // query flag that opts into the same Razorpay lookup donor.controller.js
  // does.
  getDonorByMobile: async (req, res) => {
    try {
      const mobile = normalizeMobile(req.params.mobile);
      if (!mobile) {
        return res.status(400).json({ success: false, message: "Mobile number required" });
      }

      const donor = await donorModel.findOne({ mobile }).lean();
      if (!donor) return res.json({ success: true, found: false });

      const snapshot = await buildDonorSnapshot(donor);
      res.json({ success: true, found: true, ...snapshot });
    } catch (err) {
      console.error("internal.getDonorByMobile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /api/internal/donors?page=1&limit=50
  // Paginated firehose of every donor with their full history, so DRM can
  // backfill an empty database (and re-run it later to catch up). Ordered by
  // _id so paging stays stable even while new donors are being created
  // mid-import - an offset sort on createdAt would shift rows between pages.
  listDonors: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const skip = (page - 1) * limit;

      const [donors, total] = await Promise.all([
        donorModel.find({}).sort({ _id: 1 }).skip(skip).limit(limit).lean(),
        donorModel.countDocuments({}),
      ]);

      const snapshots = await buildDonorSnapshots(donors);

      res.json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + donors.length < total,
        donors: snapshots,
      });
    } catch (err) {
      console.error("internal.listDonors error:", err);
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

module.exports = { internalController, buildDonorSnapshot };
