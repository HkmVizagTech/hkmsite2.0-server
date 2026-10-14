import { donors as donorsTable, donations } from "../db/tables.js";
import { istDayStart, istDayEnd } from "../config/timezone.js";
import { aggregate, castId } from "../domain/donationQuery.js";
import { isWhatsAppConfigured } from "../services/whatsapp.service.js";
import { sendDonationWhatsAppReceipt } from "../services/paymentCompletion.service.js";

const preacherController = {
  // GET /preacher/search-donor?q=<mobile, name, or donor ID>
  searchDonor: async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 3) return res.status(200).json({ success: true, donors: [] });

      const digitsOnly = q.replace(/\D/g, "");
      const conditions = [
        { name: { $regex: q, $options: "i" } },
        { donorId: { $regex: q, $options: "i" } },
        { dccDonorNumber: { $regex: q, $options: "i" } },
      ];
      if (digitsOnly.length >= 3) conditions.push({ mobile: { $regex: digitsOnly } });

      const donors = await donorsTable.find({ $or: conditions }, { sort: { _id: 1 }, limit: 10 });
      res.status(200).json({
        success: true,
        // DCC's DonorNumber is the real, authoritative ID once it exists;
        // donorId is only a fallback until DCC has synced a donation.
        donors: donors.map((d) => ({
          _id: d._id,
          donorId: d.dccDonorNumber || d.donorId,
          name: d.name,
          mobile: d.mobile,
          email: d.email,
        })),
      });
    } catch (err) {
      console.error("preacher.searchDonor error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // GET /preacher/my-donors — donors currently assigned to this preacher,
  // with a rollup of their total giving and donation count.
  myDonors: async (req, res) => {
    try {
      const preacherId = req.user.userId;
      const donors = await donorsTable.find({ assignedPreacherId: preacherId }, { sort: { createdAt: -1, _id: 1 } });

      const donorIds = donors.map((d) => d._id);
      const rollups = donorIds.length
        ? await aggregate(
            { donorRecordId: { $in: donorIds }, status: "completed" },
            "donor_record_id AS k, SUM(amount) AS total_amount, COUNT(*) AS count, MAX(created_at) AS last_donated_at",
            { groupBy: "donor_record_id" }
          )
        : [];
      const rollupMap = new Map(
        rollups.map((r) => [
          String(r.k),
          { totalAmount: r.total_amount, count: r.count, lastDonatedAt: r.last_donated_at },
        ])
      );

      const result = donors.map((d) => ({
        _id: d._id,
        donorId: d.dccDonorNumber || d.donorId,
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
      const donor = await donorsTable.findOne({
        _id: castId(req.params.donorRecordId),
        assignedPreacherId: req.user.userId,
      });
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found or not assigned to you." });

      const rows = await donations.find(
        { donorRecordId: donor._id },
        {
          sort: { createdAt: -1, _id: 1 },
          fields: [
            "donorName",
            "amount",
            "sevaName",
            "type",
            "status",
            "receiptNumber",
            "createdAt",
            "utrNumber",
            "manualPaymentMode",
          ],
        }
      );

      // OTP state never leaves the server (the hash of a 6-digit code is brute-forceable).
      const { otpCodeHash, otpExpiresAt, otpAttempts, otpLastRequestedAt, ...safeDonor } = donor;
      res.status(200).json({ success: true, donor: safeDonor, donations: rows });
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

      const match = { manualEnteredBy: preacherId, status: "completed" };

      if (from || to) {
        match.createdAt = {};
        if (from) {
          const d = istDayStart(from);
          if (d) match.createdAt.$gte = d;
        }
        if (to) {
          const d = istDayEnd(to);
          if (d) match.createdAt.$lte = d;
        }
      }

      const [summary, bySeva] = await Promise.all([
        aggregate(match, "COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count"),
        aggregate(match, "COALESCE(seva_name, 'General') AS k, SUM(amount) AS amount, COUNT(*) AS count", {
          groupBy: "k",
          orderBy: `amount DESC, k COLLATE "C"`,
        }),
      ]);

      res.status(200).json({
        success: true,
        summary: { totalAmount: Number(summary[0].total) || 0, count: Number(summary[0].count) || 0 },
        bySeva: bySeva.map((s) => ({ sevaName: s.k, amount: s.amount, count: s.count })),
      });
    } catch (err) {
      console.error("preacher.myReports error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  resendWhatsApp: async (req, res) => {
    try {
      const donation = await donations.findById(castId(req.params.id));
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found." });

      const ownedDirectly = String(donation.manualEnteredBy || "") === String(req.user.userId);
      const ownedViaDonor = donation.donorRecordId
        ? await donorsTable.exists({ _id: donation.donorRecordId, assignedPreacherId: req.user.userId })
        : false;

      if (!ownedDirectly && !ownedViaDonor) {
        return res.status(403).json({ success: false, message: "This donation isn't assigned to you." });
      }

      if (!isWhatsAppConfigured())
        return res.status(503).json({ success: false, message: "WhatsApp isn't configured on the server." });

      const result = await sendDonationWhatsAppReceipt(donation, { force: true });
      if (result.ok) return res.status(200).json({ success: true, message: "WhatsApp receipt sent successfully" });
      if (result.reason === "no_receipt_yet") {
        return res.status(200).json({
          success: false,
          message: "This donation doesn't have a DCC receipt yet — try again shortly.",
          skipped: true,
        });
      }
      res.status(502).json({ success: false, message: result.reason || "WhatsApp send failed" });
    } catch (err) {
      console.error("preacher.resendWhatsApp error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },
};

export { preacherController };
