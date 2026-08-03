const { donationModel } = require("../models/donation.model");
const { createRazorpayInstance } = require("./payment.controller");

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

      // Completed donations where DCC sync failed or WhatsApp receipt wasn't sent
      const needsAttentionFilter = {
        ...EXCLUDE_DONATIONS_PAGE,
        status: "completed",
        $or: [
          { dccSyncStatus: "failed" },
          { whatsappReceiptSentAt: { $exists: false } },
          { whatsappReceiptSentAt: null },
        ],
      };

      const [
        totalAgg,
        thisMonthAgg,
        lastMonthAgg,
        totalTransactions,
        donorIdentities,
        monthlyAgg,
        sevaAgg,
        needsAttentionCount,
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
        donationModel.countDocuments(needsAttentionFilter),
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
          needsAttentionCount,
          monthly,
          sevaWise,
        },
      });
    } catch (err) {
      console.error("donation stats error", err);
      res.status(500).json({ success: false, message: "Failed to fetch stats" });
    }
  },

  // GET /donations/audit-pending — reconciliation check for pending donations.
  //
  // Query params:
  //   ?fix=true    — actually update statuses (captured→completed w/ DCC pipeline,
  //                  all_failed→failed). Without this, read-only.
  //   ?scope=all   — include /donations page transactions too (default: exclude them)
  //   ?limit=100   — max transactions to check (capped at 200)
  //
  // For each transaction reports:
  //   - razorpayStatus: what Razorpay says (captured/failed/created/etc)
  //   - hasReceiptInDB: whether this donation already has a receiptNumber
  //   - action: what was done (if fix=true) or what would be done (if read-only)
  auditPending: async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const fix = req.query.fix === "true";
      const scope = req.query.scope || "seva"; // "seva" (default) or "all"

      const baseFilter = {
        status: "pending",
        razorpayOrderId: { $exists: true, $ne: null },
      };
      // By default exclude /donations page (it has its own admin). scope=all includes everything.
      if (scope !== "all") {
        Object.assign(baseFilter, EXCLUDE_DONATIONS_PAGE);
      }

      const pending = await donationModel
        .find(baseFilter)
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();

      const { completeDonation } = require("../services/paymentCompletion.service");

      const results = [];
      const summary = {
        totalChecked: 0,
        capturedAndCompleted: 0,
        capturedWithReceipt: 0,
        markedFailed: 0,
        abandoned: 0,
        genuinelyPending: 0,
        errors: 0,
      };

      for (const donation of pending) {
        summary.totalChecked++;
        const entry = {
          _id: donation._id.toString(),
          donorName: donation.donorName,
          donorEmail: donation.donorEmail,
          donorMobile: donation.donorMobile,
          amount: donation.amount,
          sevaName: donation.sevaName || donation.type,
          sourcePage: donation.sourcePage,
          createdAt: donation.createdAt,
          razorpayOrderId: donation.razorpayOrderId,
          paymentAccount: donation.paymentAccount || "default",
          hasReceiptInDB: !!(donation.receiptNumber),
          receiptNumber: donation.receiptNumber || null,
          dccSyncStatus: donation.dccSyncStatus || null,
          whatsappSent: !!donation.whatsappReceiptSentAt,
          razorpayPaymentId: donation.razorpayPaymentId || null,
          razorpayStatus: null,
          razorpayPayments: [],
          action: null,
          error: null,
        };

        try {
          const created = createRazorpayInstance(donation.paymentAccount || "default");
          if (!created) {
            entry.error = `Razorpay not configured for account "${donation.paymentAccount || "default"}"`;
            entry.action = "SKIPPED — no Razorpay keys for this account";
            summary.errors++;
            results.push(entry);
            continue;
          }

          const payments = await created.instance.orders.fetchPayments(donation.razorpayOrderId);
          const items = payments.items || [];
          entry.razorpayPayments = items.map((p) => ({
            id: p.id,
            status: p.status,
            amount: p.amount / 100,
            method: p.method,
            captured: p.status === "captured",
            created_at: p.created_at,
          }));

          const captured = items.find((p) => p.status === "captured");
          const failedPayments = items.filter((p) => p.status === "failed");

          if (captured) {
            entry.razorpayStatus = "captured";
            entry.razorpayPaymentId = captured.id;

            if (fix) {
              if (donation.receiptNumber) {
                // Already has a receipt — just update status, don't re-run DCC
                await donationModel.findByIdAndUpdate(donation._id, {
                  status: "completed",
                  razorpayPaymentId: captured.id,
                  transactionId: captured.id,
                });
                entry.action = "COMPLETED (status only — receipt already existed)";
                summary.capturedWithReceipt++;
              } else {
                // Full completion pipeline: status + DCC + WhatsApp
                await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
                entry.action = "COMPLETED (full pipeline — DCC + WhatsApp triggered)";
                summary.capturedAndCompleted++;
              }
            } else {
              entry.action = donation.receiptNumber
                ? "WOULD_COMPLETE (receipt exists, just needs status update)"
                : "WOULD_COMPLETE (needs full DCC pipeline)";
              donation.receiptNumber ? summary.capturedWithReceipt++ : summary.capturedAndCompleted++;
            }
          } else if (items.length === 0) {
            entry.razorpayStatus = "no_payments";
            entry.action = "ABANDONED — no payment attempts in Razorpay";
            summary.abandoned++;
          } else if (failedPayments.length === items.length) {
            entry.razorpayStatus = "all_failed";
            if (fix) {
              await donationModel.findByIdAndUpdate(donation._id, {
                status: "failed",
                razorpayPaymentId: failedPayments[0].id,
              });
              entry.action = "MARKED_FAILED";
            } else {
              entry.action = "WOULD_MARK_FAILED";
            }
            summary.markedFailed++;
          } else {
            const statuses = items.map((p) => p.status);
            entry.razorpayStatus = statuses.join(", ");
            entry.action = `NEEDS_REVIEW — mixed states: ${statuses.join(", ")}`;
            summary.genuinelyPending++;
          }
        } catch (err) {
          entry.error = err.message || String(err);
          entry.action = "ERROR — Razorpay API call failed";
          summary.errors++;
        }

        results.push(entry);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      res.status(200).json({
        success: true,
        mode: fix ? "FIX — records were updated" : "READ-ONLY — no records modified",
        summary,
        results,
      });
    } catch (err) {
      console.error("donation auditPending error", err);
      res.status(500).json({ success: false, message: err.message || "Audit failed" });
    }
  },

  // GET /donations/utm-stats — sitewide campaign/source/medium metrics
  // across ALL seva/campaign donation flows (excludes the standalone
  // /donations page, which has its own dedicated stats at /donations-admin).
  getUtmStats: async (req, res) => {
    try {
      const stats = await donationModel.aggregate([
        { ...{ $match: { ...EXCLUDE_DONATIONS_PAGE, status: "completed" } } },
        {
          $group: {
            _id: {
              campaign: { $ifNull: ["$utm.campaign", ""] },
              source: { $ifNull: ["$utm.source", ""] },
              medium: { $ifNull: ["$utm.medium", ""] },
            },
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: {
              campaign: { $cond: [{ $eq: ["$_id.campaign", ""] }, "direct", "$_id.campaign"] },
              source: { $cond: [{ $eq: ["$_id.source", ""] }, "direct", "$_id.source"] },
              medium: { $cond: [{ $eq: ["$_id.medium", ""] }, "none", "$_id.medium"] },
            },
            totalAmount: 1,
            count: 1,
          },
        },
        { $sort: { totalAmount: -1 } },
      ]);

      // Also break down by sourcePage, since sitewide spans 9 different
      // origin flows (unlike the single-page /donations-admin equivalent).
      const bySourcePage = await donationModel.aggregate([
        { $match: { ...EXCLUDE_DONATIONS_PAGE, status: "completed" } },
        {
          $group: {
            _id: { $ifNull: ["$sourcePage", "unknown"] },
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { totalAmount: -1 } },
      ]);

      res.status(200).json({
        success: true,
        stats,
        bySourcePage: bySourcePage.map((r) => ({ sourcePage: r._id, totalAmount: r.totalAmount, count: r.count })),
      });
    } catch (error) {
      console.error("donation.getUtmStats error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM stats" });
    }
  },

  // GET /donations/utm-transactions?campaign=&source=&medium=&sourcePage=
  // Drill-down: real transaction list for one specific campaign/page row.
  getUtmTransactions: async (req, res) => {
    try {
      const { campaign, source, medium, sourcePage } = req.query;
      const match = { ...EXCLUDE_DONATIONS_PAGE, status: "completed" };
      if (campaign) match["utm.campaign"] = campaign === "direct" ? { $in: [null, ""] } : campaign;
      if (source) match["utm.source"] = source === "direct" ? { $in: [null, ""] } : source;
      if (medium) match["utm.medium"] = medium === "none" ? { $in: [null, ""] } : medium;
      if (sourcePage) match["sourcePage"] = sourcePage === "unknown" ? { $in: [null, ""] } : sourcePage;

      const transactions = await donationModel
        .find(match)
        .sort({ createdAt: -1 })
        .limit(200)
        .select("donorName donorEmail donorMobile amount status createdAt sourcePage utm receiptNumber razorpayPaymentId sevaName type")
        .lean();

      res.status(200).json({ success: true, count: transactions.length, transactions });
    } catch (error) {
      console.error("donation.getUtmTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM transactions" });
    }
  },

  list: async (req, res) => {
    try {
      const { type, status, date, festivalId, festivalSlug, q, from, to, minAmount, maxAmount } = req.query;
      let filter = { ...EXCLUDE_DONATIONS_PAGE };
      if (type) filter.type = type;
      if (status === 'needs_attention') {
        filter.status = 'completed';
        filter.$or = [
          { dccSyncStatus: 'failed' },
          { whatsappReceiptSentAt: { $exists: false } },
          { whatsappReceiptSentAt: null },
        ];
      } else if (status && status !== 'all') {
        filter.status = status;
      }
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
        const searchOr = [ { donorName: re }, { donorEmail: re }, { donorMobile: re }, { transactionId: re }, { razorpayOrderId: re } ];
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
          delete filter.$or;
        } else {
          filter.$or = searchOr;
        }
      }

      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '20', 10)));
      const skip = (page - 1) * limit;

      const projection = {
        donorName: 1, donorEmail: 1, donorMobile: 1, amount: 1, status: 1, date: 1,
        panNumber: 1, certificate: 1, wantPrasadam: 1, prasadamAddress: 1,
        transactionId: 1, razorpayOrderId: 1, razorpayPaymentId: 1,
        receiptNumber: 1, dccSyncStatus: 1, whatsappReceiptSentAt: 1, whatsappReceiptError: 1,
        sevaName: 1, type: 1, sourcePage: 1, utm: 1, createdAt: 1,
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
