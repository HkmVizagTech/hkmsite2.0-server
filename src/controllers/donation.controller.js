const { donationModel } = require("../models/donation.model");

// The standalone /donations page is fully separate from the rest of the
// site's donation flows (seva pages, sqft campaign, janmashtami) and has
// its own dedicated admin at /donations/admin — it must never show up
// blended into this main site-wide donations list/stats.
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $ne: "donations" } };

const donationController = {
  // GET /donations/stats — real aggregated analytics for the main admin
  // donations dashboard. Every number comes from the database, nothing
  // hardcoded. Scoped to seva/campaign donations only (EXCLUDE_DONATIONS_PAGE).
  stats: async (req, res) => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      // 12 months ago for the bar chart
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

      const completedBase = { ...EXCLUDE_DONATIONS_PAGE, status: "completed" };

      const [
        totalAgg,
        thisMonthAgg,
        lastMonthAgg,
        totalTransactions,
        donorIdentities,
        monthlyAgg,
        sevaAgg,
      ] = await Promise.all([
        // Total collected (completed only)
        donationModel.aggregate([
          { $match: completedBase },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        // This month (completed)
        donationModel.aggregate([
          { $match: { ...completedBase, createdAt: { $gte: startOfMonth } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // Last month (for % change)
        donationModel.aggregate([
          { $match: { ...completedBase, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // Total transaction count (all statuses)
        donationModel.countDocuments(EXCLUDE_DONATIONS_PAGE),
        // Unique donors — union of email + mobile
        donationModel.aggregate([
          { $match: completedBase },
          {
            $group: {
              _id: {
                $cond: [
                  { $and: [{ $ne: ["$donorEmail", null] }, { $ne: ["$donorEmail", ""] }] },
                  { $toLower: "$donorEmail" },
                  { $ifNull: ["$donorMobile", "$$REMOVE"] },
                ],
              },
            },
          },
          { $count: "count" },
        ]),
        // Monthly donations (last 12 months, completed)
        donationModel.aggregate([
          { $match: { ...completedBase, createdAt: { $gte: twelveMonthsAgo } } },
          {
            $group: {
              _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]),
        // Seva-wise split (completed)
        donationModel.aggregate([
          { $match: completedBase },
          {
            $group: {
              _id: { $ifNull: [{ $ifNull: ["$sevaName", "$type"] }, "General"] },
              value: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { value: -1 } },
        ]),
      ]);

      const totalCollected = totalAgg[0]?.total || 0;
      const totalCount = totalAgg[0]?.count || 0;
      const thisMonthTotal = thisMonthAgg[0]?.total || 0;
      const lastMonthTotal = lastMonthAgg[0]?.total || 0;
      const changePct = lastMonthTotal
        ? Number((((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100).toFixed(1))
        : null;

      // Format monthly data with readable labels
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthly = monthlyAgg.map((m) => ({
        month: `${monthNames[m._id.month - 1]} ${m._id.year}`,
        amount: m.amount,
        count: m.count,
      }));

      const sevaWise = sevaAgg.map((s) => ({
        name: s._id,
        value: s.value,
        count: s.count,
      }));

      // Current month label
      const currentMonthLabel = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

      res.status(200).json({
        success: true,
        stats: {
          totalCollected,
          totalCompletedCount: totalCount,
          totalTransactions,
          totalDonors: donorIdentities[0]?.count || 0,
          thisMonth: { value: thisMonthTotal, changePct, label: currentMonthLabel },
          monthly,
          sevaWise,
        },
      });
    } catch (err) {
      console.error("donation stats error", err);
      res.status(500).json({ success: false, message: "Failed to fetch stats" });
    }
  },

  list: async (req, res) => {
    try {
      const { type, status, date, festivalId, festivalSlug, q, from, to, minAmount, maxAmount } = req.query;
      let filter = { ...EXCLUDE_DONATIONS_PAGE };
      if (type) filter.type = type;
      if (status && status !== 'all') filter.status = status;
      if (date) {
        const start = new Date(date);
        const end = new Date(date);
        end.setHours(23, 59, 59, 999);
        filter.date = { $gte: start, $lte: end };
      }
      if (from) {
        filter.date = filter.date || {};
        filter.date.$gte = new Date(from);
      }
      if (to) {
        filter.date = filter.date || {};
        const d = new Date(to); d.setHours(23,59,59,999);
        filter.date.$lte = d;
      }
      if (festivalId) filter.festivalId = festivalId;
      if (festivalSlug) filter.festivalSlug = festivalSlug;
      if (minAmount) filter.amount = Object.assign({}, filter.amount, { $gte: Number(minAmount) });
      if (maxAmount) filter.amount = Object.assign({}, filter.amount, { $lte: Number(maxAmount) });
      if (q) {
        const re = new RegExp(String(q), 'i');
        filter.$or = [ { donorName: re }, { donorEmail: re }, { donorMobile: re }, { transactionId: re }, { razorpayOrderId: re } ];
      }

      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '20', 10)));
      const skip = (page - 1) * limit;

      const projection = {
        donorName: 1, donorEmail: 1, donorMobile: 1, amount: 1, status: 1, date: 1,
        panNumber: 1, certificate: 1, wantPrasadam: 1, prasadamAddress: 1,
        transactionId: 1, razorpayOrderId: 1, razorpayPaymentId: 1,
        receiptNumber: 1, dccSyncStatus: 1, whatsappReceiptSentAt: 1, whatsappReceiptError: 1,
        sevaName: 1, type: 1,
      };

      const [total, donations] = await Promise.all([
        donationModel.countDocuments(filter),
        donationModel.find(filter).sort({ date: -1 }).skip(skip).limit(limit).select(projection).lean()
      ]);

      res.status(200).json({ donations, total, page, limit });
    } catch (err) {
      console.error('donation list error', err);
      res.status(500).json({ message: "Server error" });
    }
  },

  get: async (req, res) => {
    try {
      const donation = await donationModel.findById(req.params.id);
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      res.status(200).json({ donation });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      const { donorName, donorEmail, donorMobile, amount, type, message, transactionId, festivalId, festivalSlug,
        panNumber, certificate, wantPrasadam, prasadamAddress, razorpayOrderId } = req.body;
      if (!donorName || !amount) {
        return res.status(400).json({ message: "Name and amount are required" });
      }
      let resolvedFestivalId = festivalId;
      if (!resolvedFestivalId && festivalSlug) {
        try {
          const { festivalDonationModel } = require('../models/festivalDonation.model');
          const fest = await festivalDonationModel.findOne({ slug: festivalSlug }).select('_id');
          if (fest) resolvedFestivalId = fest._id;
        } catch (err) {
          console.warn('Could not resolve festivalSlug to festivalId', festivalSlug, err);
        }
      }
      const donation = await donationModel.create({
        donorName,
        donorEmail,
        donorMobile,
        amount,
        type,
        message,
        transactionId,
        festivalId: resolvedFestivalId,
        festivalSlug,
        panNumber,
        certificate,
        wantPrasadam,
        prasadamAddress,
        razorpayOrderId,
        status: "pending"
      });
      res.status(201).json({ message: "Donation created", donation });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const donation = await donationModel.findByIdAndUpdate(id, req.body, { new: true });
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      res.status(200).json({ message: "Donation updated", donation });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      await donationModel.findByIdAndDelete(id);
      res.status(200).json({ message: "Donation deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN - real "Resend Receipt" action: force-retries the DCC donor-CRM
  // sync for this donation, which is what actually generates/re-generates
  // the receiptNumber. Replaces the previous no-op empty-body PUT.
  resendReceipt: async (req, res) => {
    try {
      const { id } = req.params;
      const { syncDonationToDcc, isDccConfigured } = require("../services/dcc.service");
      const donation = await donationModel.findById(id);
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      if (!isDccConfigured()) {
        return res.status(200).json({
          message: "DCC_API_KEY is not configured on this server, so no receipt system is connected yet. Nothing was sent.",
          skipped: true,
        });
      }

      const result = await syncDonationToDcc(id);
      if (result.ok) {
        return res.status(200).json({ message: "Receipt sync re-triggered successfully", receiptNumber: result.receiptNumber });
      }
      return res.status(502).json({ message: "Receipt resync failed", error: result.error });
    } catch (err) {
      console.error("Resend receipt error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - manually re-trigger the WhatsApp receipt message, isolated from
  // DCC so a WhatsApp-only failure (bad phone, template not approved yet)
  // can be retried without re-running the DCC sync.
  resendWhatsApp: async (req, res) => {
    try {
      const { id } = req.params;
      const { isWhatsAppConfigured } = require("../services/whatsapp.service");
      const { sendDonationWhatsAppReceipt } = require("../services/paymentCompletion.service");
      const donation = await donationModel.findById(id);
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      if (!isWhatsAppConfigured()) {
        return res.status(200).json({
          message: "WAPI_TOKEN is not configured on this server, so WhatsApp isn't connected yet. Nothing was sent.",
          skipped: true,
        });
      }

      const result = await sendDonationWhatsAppReceipt(donation);
      if (result.ok) {
        return res.status(200).json({ message: "WhatsApp receipt sent successfully" });
      }
      if (result.reason === "no_receipt_yet") {
        return res.status(200).json({
          message: "This donation doesn't have a DCC receipt number yet, so no WhatsApp message was sent (per policy, we never message a donor without the real receipt). Try 'Resend Receipt' first, then Resend WhatsApp again.",
          skipped: true,
        });
      }
      return res.status(502).json({ message: result.reason || "WhatsApp send failed", error: result.error });
    } catch (err) {
      console.error("Resend WhatsApp error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // GET /donations/whatsapp-audit — finds donations where whatsappReceiptSentAt
  // is set but there's no receiptNumber. These are stale from before the
  // no-receipt-no-WhatsApp policy: the old fallback behavior sent a plain
  // text message even when DCC hadn't returned a receipt yet, so this field
  // reflects a real send that happened, but under the current policy it's
  // misleading in the admin UI (looks like "receipt sent" when no receipt
  // ever existed). ?fix=true clears the field on all matches found.
  whatsappAudit: async (req, res) => {
    try {
      const query = {
        whatsappReceiptSentAt: { $ne: null },
        $or: [{ receiptNumber: null }, { receiptNumber: { $exists: false } }, { receiptNumber: "" }],
      };
      const stale = await donationModel
        .find(query)
        .select("_id donorName donorMobile amount sourcePage sevaName whatsappReceiptSentAt dccSyncStatus")
        .lean();

      if (req.query.fix === "true" && stale.length > 0) {
        await donationModel.updateMany(query, { $set: { whatsappReceiptSentAt: null } });
      }

      res.status(200).json({
        found: stale.length,
        fixed: req.query.fix === "true",
        donations: stale,
      });
    } catch (err) {
      console.error("WhatsApp audit error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { donationController };
