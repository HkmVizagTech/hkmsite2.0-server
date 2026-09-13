const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");

const preacherController = {
  // GET /preacher/my-donors — donors currently assigned to this preacher,
  // with a rollup of their total giving and donation count.
  myDonors: async (req, res) => {
    try {
      const preacherId = req.user.userId;
      const donors = await donorModel.find({ assignedPreacherId: preacherId }).sort({ createdAt: -1 }).lean();

      const donorIds = donors.map((d) => d._id);
      const rollups = await donationModel.aggregate([
        { $match: { donorRecordId: { $in: donorIds }, status: "completed" } },
        { $group: { _id: "$donorRecordId", totalAmount: { $sum: "$amount" }, count: { $sum: 1 }, lastDonatedAt: { $max: "$createdAt" } } },
      ]);
      const rollupMap = new Map(rollups.map((r) => [String(r._id), r]));

      const result = donors.map((d) => ({
        _id: d._id,
        donorId: d.donorId,
        name: d.name,
        mobile: d.mobile,
        email: d.email,
        totalAmount: rollupMap.get(String(d._id))?.totalAmount || 0,
        donationCount: rollupMap.get(String(d._id))?.count || 0,
        lastDonatedAt: rollupMap.get(String(d._id))?.lastDonatedAt || null,
      }));

      res.status(200).json({ success: true, count: result.length, donors: result });
    } catch (err) {
      console.error("preacher.myDonors error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // GET /preacher/my-donors/:donorRecordId/donations — a specific donor's
  // full donation history, only if that donor is assigned to THIS preacher.
  donorDonations: async (req, res) => {
    try {
      const donor = await donorModel.findOne({ _id: req.params.donorRecordId, assignedPreacherId: req.user.userId }).lean();
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found or not assigned to you." });

      const donations = await donationModel
        .find({ donorRecordId: donor._id })
        .sort({ createdAt: -1 })
        .select("donorName amount sevaName type status receiptNumber createdAt utrNumber manualPaymentMode")
        .lean();

      res.status(200).json({ success: true, donor, donations });
    } catch (err) {
      console.error("preacher.donorDonations error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // GET /preacher/my-reports?from=&to= — this preacher's own totals,
  // scoped to donations THEY raised.
  myReports: async (req, res) => {
    try {
      const preacherId = req.user.userId;
      const { from, to } = req.query;
      const mongoose = require("mongoose");
      const match = { manualEnteredBy: new mongoose.Types.ObjectId(preacherId), status: "completed" };

      if (from || to) {
        match.createdAt = {};
        if (from) match.createdAt.$gte = new Date(from);
        if (to) {
          const end = new Date(to);
          end.setHours(23, 59, 59, 999);
          match.createdAt.$lte = end;
        }
      }

      const [summary, bySeva] = await Promise.all([
        donationModel.aggregate([
          { $match: match },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        donationModel.aggregate([
          { $match: match },
          { $group: { _id: { $ifNull: ["$sevaName", "General"] }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { amount: -1 } },
        ]),
      ]);

      res.status(200).json({
        success: true,
        summary: { totalAmount: summary[0]?.total || 0, count: summary[0]?.count || 0 },
        bySeva: bySeva.map((s) => ({ sevaName: s._id, amount: s.amount, count: s.count })),
      });
    } catch (err) {
      console.error("preacher.myReports error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // POST /preacher/donations/:id/resend-whatsapp — same as the admin
  // resend, but only allowed if this donation belongs to a donor
  // assigned to THIS preacher (or was raised by them directly).
  resendWhatsApp: async (req, res) => {
    try {
      const donation = await donationModel.findById(req.params.id);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found." });

      const ownedDirectly = String(donation.manualEnteredBy || "") === String(req.user.userId);
      const ownedViaDonor = donation.donorRecordId
        ? await donorModel.exists({ _id: donation.donorRecordId, assignedPreacherId: req.user.userId })
        : false;

      if (!ownedDirectly && !ownedViaDonor) {
        return res.status(403).json({ success: false, message: "This donation isn't assigned to you." });
      }

      const { isWhatsAppConfigured } = require("../services/whatsapp.service");
      const { sendDonationWhatsAppReceipt } = require("../services/paymentCompletion.service");

      if (!isWhatsAppConfigured()) return res.status(503).json({ success: false, message: "WhatsApp isn't configured on the server." });

      const result = await sendDonationWhatsAppReceipt(donation, { force: true });
      if (result.ok) return res.status(200).json({ success: true, message: "WhatsApp receipt sent successfully" });
      if (result.reason === "no_receipt_yet") {
        return res.status(200).json({ success: false, message: "This donation doesn't have a DCC receipt yet — try again shortly.", skipped: true });
      }
      res.status(502).json({ success: false, message: result.reason || "WhatsApp send failed" });
    } catch (err) {
      console.error("preacher.resendWhatsApp error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },
};

module.exports = { preacherController };
