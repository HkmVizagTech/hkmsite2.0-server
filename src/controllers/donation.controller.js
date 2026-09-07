const { donationModel } = require("../models/donation.model");
const { createRazorpayInstance } = require("./payment.controller");

// The standalone /donations page is fully separate from the rest of the
// site's donation flows (seva pages, sqft campaign, janmashtami) and has
// its own dedicated admin at /donations/admin — it must never show up
// blended into this main site-wide donations list/stats.
// /donations/janmashtami2 is treated the same way by explicit request —
// it lives under the /donations path and its donations should follow
// the same DCC/accounting treatment (enrolledBy default, excluded here,
// shown only in /donations/admin) as the /donations page itself.
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $nin: ["donations", "donations/janmashtami2"] } };

// Shared helper: builds a { createdAt: {...} } match clause from optional
// YYYY-MM-DD from/to query params. `to` is inclusive through end of day.
function buildDateRangeMatch(from, to) {
  if (!from && !to) return {};
  const createdAt = {};
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) createdAt.$gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      createdAt.$lte = d;
    }
  }
  return Object.keys(createdAt).length ? { createdAt } : {};
}

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

      const { reconcilePendingDonations } = require("../services/reconciliation.service");
      const { summary, results } = await reconcilePendingDonations({ limit, fix, scope });

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

  // GET /donations/utm-stats?from=&to= — sitewide campaign/source/medium
  // metrics across ALL seva/campaign donation flows (excludes the
  // standalone /donations page, which has its own dedicated stats at
  // /donations-admin). Optional from/to (YYYY-MM-DD) filters by createdAt.
  getUtmStats: async (req, res) => {
    try {
      const { from, to } = req.query;
      const dateMatch = buildDateRangeMatch(from, to);
      const baseMatch = { ...EXCLUDE_DONATIONS_PAGE, status: "completed", ...dateMatch };

      const stats = await donationModel.aggregate([
        { $match: baseMatch },
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
        { $match: baseMatch },
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

  // GET /donations/utm-transactions?campaign=&source=&medium=&sourcePage=&from=&to=
  // Drill-down: real transaction list for one specific campaign/page row.
  getUtmTransactions: async (req, res) => {
    try {
      const { campaign, source, medium, sourcePage, from, to } = req.query;
      const match = { ...EXCLUDE_DONATIONS_PAGE, status: "completed", ...buildDateRangeMatch(from, to) };
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

  // GET /donations/report?period=today|yesterday|week|month|year|custom&from=&to=
  // One endpoint backing all the report views in the admin Reports tab.
  // Returns total/count/average for the period, a comparison against the
  // equivalent previous period, seva-wise and status breakdowns, and a
  // day-by-day (or month-by-month for "year") series for charting.
  getReport: async (req, res) => {
    try {
      const { period = "today", from, to } = req.query;
      const now = new Date();

      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

      let start, end, prevStart, prevEnd, granularity = "day";

      if (period === "today") {
        start = startOfDay(now); end = endOfDay(now);
        const yest = new Date(now); yest.setDate(yest.getDate() - 1);
        prevStart = startOfDay(yest); prevEnd = endOfDay(yest);
      } else if (period === "yesterday") {
        const yest = new Date(now); yest.setDate(yest.getDate() - 1);
        start = startOfDay(yest); end = endOfDay(yest);
        const dayBefore = new Date(yest); dayBefore.setDate(dayBefore.getDate() - 1);
        prevStart = startOfDay(dayBefore); prevEnd = endOfDay(dayBefore);
      } else if (period === "week") {
        const dow = now.getDay(); // 0 = Sunday
        const monday = new Date(now); monday.setDate(now.getDate() - ((dow + 6) % 7));
        start = startOfDay(monday); end = endOfDay(now);
        const prevMonday = new Date(monday); prevMonday.setDate(prevMonday.getDate() - 7);
        const prevSunday = new Date(monday); prevSunday.setDate(prevSunday.getDate() - 1);
        prevStart = startOfDay(prevMonday); prevEnd = endOfDay(prevSunday);
      } else if (period === "month") {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = endOfDay(now);
        prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      } else if (period === "year") {
        start = new Date(now.getFullYear(), 0, 1);
        end = endOfDay(now);
        prevStart = new Date(now.getFullYear() - 1, 0, 1);
        prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
        granularity = "month";
      } else if (period === "custom") {
        if (!from || !to) return res.status(400).json({ success: false, message: "from and to are required for a custom period." });
        start = startOfDay(new Date(from));
        end = endOfDay(new Date(to));
        const spanMs = end.getTime() - start.getTime();
        prevEnd = new Date(start.getTime() - 1);
        prevStart = new Date(prevEnd.getTime() - spanMs);
        granularity = spanMs > 45 * 24 * 60 * 60 * 1000 ? "month" : "day";
      } else {
        return res.status(400).json({ success: false, message: "Invalid period." });
      }

      const baseMatch = { ...EXCLUDE_DONATIONS_PAGE, createdAt: { $gte: start, $lte: end } };
      const completedMatch = { ...baseMatch, status: "completed" };
      const prevCompletedMatch = { ...EXCLUDE_DONATIONS_PAGE, status: "completed", createdAt: { $gte: prevStart, $lte: prevEnd } };

      const dateTrunc = granularity === "month"
        ? { $dateToString: { format: "%Y-%m", date: "$createdAt" } }
        : { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };

      const [summaryAgg, prevSummaryAgg, sevaAgg, statusAgg, seriesAgg] = await Promise.all([
        donationModel.aggregate([
          { $match: completedMatch },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        donationModel.aggregate([
          { $match: prevCompletedMatch },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        donationModel.aggregate([
          { $match: completedMatch },
          { $group: { _id: { $ifNull: ["$sevaName", { $ifNull: ["$type", "General"] }] }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { amount: -1 } },
          { $limit: 15 },
        ]),
        donationModel.aggregate([
          { $match: baseMatch },
          { $group: { _id: "$status", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        donationModel.aggregate([
          { $match: completedMatch },
          { $group: { _id: dateTrunc, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
      ]);

      const total = summaryAgg[0]?.total || 0;
      const count = summaryAgg[0]?.count || 0;
      const prevTotal = prevSummaryAgg[0]?.total || 0;
      const prevCount = prevSummaryAgg[0]?.count || 0;
      const percentChange = prevTotal > 0 ? Number((((total - prevTotal) / prevTotal) * 100).toFixed(1)) : null;

      res.status(200).json({
        success: true,
        period,
        range: { start, end },
        summary: {
          totalAmount: total,
          count,
          avgDonation: count > 0 ? Math.round(total / count) : 0,
          previousPeriod: { totalAmount: prevTotal, count: prevCount },
          percentChange,
        },
        sevaBreakdown: sevaAgg.map((s) => ({ name: s._id, amount: s.amount, count: s.count })),
        statusBreakdown: statusAgg.map((s) => ({ status: s._id, amount: s.amount, count: s.count })),
        series: seriesAgg.map((s) => ({ date: s._id, amount: s.amount, count: s.count })),
        granularity,
      });
    } catch (error) {
      console.error("donation.getReport error:", error);
      res.status(500).json({ success: false, message: "Failed to generate report" });
    }
  },

  // POST /donations/manual — ADMIN ONLY. Records a donation that arrived
  // OUTSIDE the website checkout entirely (direct bank transfer, UPI paid
  // straight to the temple's VPA, cash, cheque) using the bank/UPI
  // reference (UTR) to identify the payment instead of a Razorpay ID.
  // Creates the record already completed (admin is confirming money has
  // actually arrived) and runs the SAME DCC + WhatsApp receipt pipeline as
  // any other completed donation — deliberately skips the Meta CAPI
  // purchase event since this was never an on-site/ad-attributed
  // conversion and sending it would inflate ad performance data.
  createManual: async (req, res) => {
    try {
      const {
        donorName, donorEmail, donorMobile, amount, type, sevaName,
        utrNumber, manualPaymentMode, paymentDate, manualEntryNote,
        panNumber, certificate, wantPrasadam, prasadamAddress,
        sevakName, dob, devoteeId,
      } = req.body;

      const name = String(donorName || "").trim();
      const amt = Number(amount);
      const utr = String(utrNumber || "").trim();

      if (!name) return res.status(400).json({ success: false, message: "Donor name is required." });
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ success: false, message: "A valid amount is required." });
      if (!utr) return res.status(400).json({ success: false, message: "UTR / reference number is required to record a manual payment." });
      if (!donorEmail && !donorMobile) return res.status(400).json({ success: false, message: "Please provide at least an email or mobile number for the receipt." });

      const validModes = ["upi", "bank", "cash", "cheque"];
      const mode = validModes.includes(manualPaymentMode) ? manualPaymentMode : "bank";

      // Optional "Enrolled By" devotee — same mechanism as campaigner
      // attribution. If selected, the DCC receipt is credited to that
      // devotee instead of the generic default (36 for most flows).
      let dccEnrolledById;
      if (devoteeId) {
        const { templeDevoteeModel } = require("../models/templeDevotee.model");
        const devotee = await templeDevoteeModel.findById(devoteeId).lean();
        if (devotee?.dccEnrolledById != null) dccEnrolledById = devotee.dccEnrolledById;
      }

      // Duplicate-UTR guard — the same bank reference should never be
      // entered twice (classic double-entry mistake).
      const existingWithUtr = await donationModel.findOne({ utrNumber: utr }).lean();
      if (existingWithUtr) {
        return res.status(409).json({
          success: false,
          message: `This UTR is already recorded against a donation from ${existingWithUtr.donorName} (₹${existingWithUtr.amount}, ${new Date(existingWithUtr.createdAt).toLocaleDateString("en-IN")}).`,
        });
      }

      const donation = await donationModel.create({
        donorName: name,
        donorEmail: donorEmail ? String(donorEmail).trim().toLowerCase() : undefined,
        donorMobile: donorMobile ? String(donorMobile).trim() : undefined,
        amount: amt,
        type: type || "Manual Entry",
        sevaName: sevaName || undefined,
        sourcePage: "admin-manual",
        status: "pending", // completeDonation flow below transitions this properly
        date: paymentDate ? new Date(paymentDate) : new Date(),
        manualEntry: true,
        utrNumber: utr,
        manualPaymentMode: mode,
        manualEntryNote: manualEntryNote || undefined,
        manualEnteredBy: req.user?.userId || undefined,
        dccEnrolledById,
        panNumber: panNumber || undefined,
        certificate: !!certificate,
        wantPrasadam: !!wantPrasadam,
        prasadamAddress: wantPrasadam ? prasadamAddress : undefined,
        sevakName: sevakName || undefined,
        dob: dob || undefined,
      });

      const { markDonationCompleted, sendDonationWhatsAppReceipt } = require("../services/paymentCompletion.service");
      await markDonationCompleted({ donationId: donation._id });

      // DCC sync + WhatsApp — same pipeline as automated completions,
      // Meta CAPI deliberately excluded (see comment above).
      try {
        const { syncDonationToDcc: dccSync } = require("../services/dcc.service");
        await dccSync(await donationModel.findById(donation._id), utr);
      } catch (e) {
        console.error("Manual entry DCC sync failed:", e && e.message ? e.message : e);
      }
      try {
        await sendDonationWhatsAppReceipt(await donationModel.findById(donation._id));
      } catch (e) {
        console.error("Manual entry WhatsApp receipt failed:", e && e.message ? e.message : e);
      }

      const final = await donationModel.findById(donation._id);
      res.status(201).json({ success: true, donation: final });
    } catch (error) {
      console.error("donation.createManual error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to record manual donation" });
    }
  },

  // PUT /donations/:id/manual-complete — ADMIN ONLY. For a donation that
  // ALREADY exists (donor attempted on-site and got stuck pending) but
  // where the payment actually arrived via a channel with no Razorpay
  // order to reconcile against (e.g. they abandoned checkout, then paid
  // by scanning the UPI QR directly). Attaches a UTR and completes it
  // through the same pipeline — avoids creating a duplicate record.
  completeManualPending: async (req, res) => {
    try {
      const { utrNumber, manualPaymentMode, manualEntryNote } = req.body;
      const utr = String(utrNumber || "").trim();
      if (!utr) return res.status(400).json({ success: false, message: "UTR / reference number is required." });

      const donation = await donationModel.findById(req.params.id);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });
      if (donation.status === "completed") {
        return res.status(409).json({ success: false, message: "This donation is already completed." });
      }

      const existingWithUtr = await donationModel.findOne({ utrNumber: utr, _id: { $ne: donation._id } }).lean();
      if (existingWithUtr) {
        return res.status(409).json({
          success: false,
          message: `This UTR is already recorded against another donation (${existingWithUtr.donorName}, ₹${existingWithUtr.amount}).`,
        });
      }

      const validModes = ["upi", "bank", "cash", "cheque"];
      const mode = validModes.includes(manualPaymentMode) ? manualPaymentMode : "upi";

      await donationModel.findByIdAndUpdate(donation._id, {
        manualEntry: true,
        utrNumber: utr,
        manualPaymentMode: mode,
        manualEntryNote: manualEntryNote || undefined,
        manualEnteredBy: req.user?.userId || undefined,
      });

      const { markDonationCompleted, sendDonationWhatsAppReceipt } = require("../services/paymentCompletion.service");
      await markDonationCompleted({ donationId: donation._id });

      try {
        const { syncDonationToDcc: dccSync } = require("../services/dcc.service");
        await dccSync(await donationModel.findById(donation._id), utr);
      } catch (e) {
        console.error("Manual completion DCC sync failed:", e && e.message ? e.message : e);
      }
      try {
        await sendDonationWhatsAppReceipt(await donationModel.findById(donation._id));
      } catch (e) {
        console.error("Manual completion WhatsApp receipt failed:", e && e.message ? e.message : e);
      }

      const final = await donationModel.findById(donation._id);
      res.status(200).json({ success: true, donation: final });
    } catch (error) {
      console.error("donation.completeManualPending error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to complete donation" });
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
        manualEntry: 1, utrNumber: 1, manualPaymentMode: 1, manualEntryNote: 1,
      };

      const [total, donations, totalAmountAgg] = await Promise.all([
        donationModel.countDocuments(filter),
        donationModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select(projection).lean(),
        donationModel.aggregate([{ $match: filter }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      ]);

      res.status(200).json({ donations, total, page, limit, totalAmount: totalAmountAgg[0]?.sum || 0 });
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

  // ADMIN - manually set the DCC receipt number on a donation when DCC
  // already has it in their system but the sync was never linked back
  // (e.g. the "Transaction details exist" error from DCC). Useful when
  // you log into DCC directly and find the receipt number there.
  patchReceiptNumber: async (req, res) => {
    try {
      const { receiptNumber } = req.body;
      const clean = String(receiptNumber || "").trim();
      if (!clean) return res.status(400).json({ success: false, message: "receiptNumber is required." });

      const donation = await donationModel.findByIdAndUpdate(
        req.params.id,
        {
          receiptNumber: clean,
          dccSyncStatus: "synced",
          dccSyncedAt: new Date(),
          dccSyncError: null,
        },
        { new: true }
      );
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found." });
      res.status(200).json({ success: true, message: `Receipt number set to ${clean}`, donation });
    } catch (err) {
      console.error("patchReceiptNumber error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // GET /donations/needs-manual-receipt — completed donations where DCC
  // already has the transaction on record (from a prior sync attempt that
  // succeeded on their side without the response reaching us) but we never
  // captured a receipt number, so it's stuck needing a human to look it up
  // in DCC directly. DCC's addDonation API is create-only and doesn't
  // return the receipt number in this "already exists" response, and there
  // is no lookup/search endpoint in their API to query it back — this list
  // is the practical way to see and clear the backlog quickly instead of
  // discovering these one at a time.
  needsManualReceipt: async (req, res) => {
    try {
      const donations = await donationModel
        .find({
          status: "completed",
          receiptNumber: { $in: [null, ""] },
          $or: [
            { dccSyncStatus: "failed" },
            { dccSyncError: { $regex: "transaction details exist", $options: "i" } },
          ],
        })
        .sort({ createdAt: -1 })
        .limit(200)
        .select("donorName donorEmail donorMobile amount sevaName type createdAt dccSyncStatus dccSyncError razorpayPaymentId utrNumber")
        .lean();

      res.status(200).json({ success: true, count: donations.length, donations });
    } catch (err) {
      console.error("needsManualReceipt error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // GET /donations/needs-whatsapp — completed donations that HAVE a real
  // DCC receipt number but never got a WhatsApp receipt delivered (no
  // phone number, WhatsApp not configured at the time, API/template
  // error, or the donor's number bounced). Flagged here specifically so
  // admin can review and send manually — separate from Needs Manual
  // Receipt, which is about missing receipt NUMBERS, not missing
  // deliveries of a receipt that already exists.
  needsWhatsApp: async (req, res) => {
    try {
      const donations = await donationModel
        .find({
          status: "completed",
          receiptNumber: { $nin: [null, ""] },
          $or: [
            // Never sent at all.
            { whatsappReceiptSentAt: { $in: [null, undefined] } },
            // Sent, accepted by the provider's API, then reported FAILED by
            // the delivery callback — the donor has no receipt even though
            // whatsappReceiptSentAt is set. Without this clause those
            // donations were invisible: the send looked successful and only
            // the callback knew otherwise.
            { whatsappDeliveryStatus: "failed" },
          ],
        })
        .sort({ createdAt: -1 })
        .limit(200)
        .select(
          "donorName donorEmail donorMobile amount sevaName type createdAt receiptNumber whatsappReceiptError whatsappReceiptSentAt whatsappProvider whatsappDeliveryStatus"
        )
        .lean();

      res.status(200).json({ success: true, count: donations.length, donations });
    } catch (err) {
      console.error("needsWhatsApp error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // TEMPORARY diagnostic — direct, unambiguous check of exactly which
  // donations have sourcePage="donations/janmashtami2", since other list
  // endpoints either exclude these by design or don't project sourcePage
  // in their response, making it impossible to confirm via those alone.
  debugJanmashtami2: async (req, res) => {
    try {
      const donations = await donationModel
        .find({ sourcePage: "donations/janmashtami2" })
        .sort({ createdAt: -1 })
        .select("donorName amount status paymentAccount razorpayOrderId razorpayPaymentId createdAt")
        .lean();
      res.status(200).json({ success: true, count: donations.length, donations });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // TEMPORARY - quick count of the true sitewide pending backlog (matching
  // the reconciliation service's own base filter), so we know how many
  // audit-pending passes are actually needed instead of guessing.
  debugPendingCount: async (req, res) => {
    try {
      const total = await donationModel.countDocuments({ status: "pending", razorpayOrderId: { $exists: true, $ne: null } });
      const janm2Pending = await donationModel.countDocuments({ status: "pending", sourcePage: "donations/janmashtami2", razorpayOrderId: { $exists: true, $ne: null } });
      res.status(200).json({ success: true, totalPendingSitewide: total, janmashtami2Pending: janm2Pending });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ADMIN - bulk resend for a window of receipts that never went out, e.g.
  // the hours in which every Flaxxa send failed on that number's spam/quality
  // limit. Same auth as the rest of this admin API; no internal secret and no
  // shell access needed, which is the point — this is driven from the Needs
  // WhatsApp tab.
  //
  // POST /donations/resend-recent-whatsapp  { hours, limit, send }
  //   send !== true  -> DRY RUN: returns exactly who would be messaged.
  //   send === true  -> sends, sequentially, with a delay between each.
  //
  // Safe to run twice: it only picks donations with no recorded receipt send,
  // and the send path keeps its idempotency guard (no force), so a donor who
  // already has a receipt is skipped rather than messaged again.
  resendRecentWhatsApp: async (req, res) => {
    try {
      const body = req.body || {};
      // hours = 0 (or "all") drops the time window entirely: every donation
      // with a receipt and no recorded send. Offline/manual donations are the
      // reason this matters — the window filters on when the donation record
      // was created, not when its receipt was raised.
      const rawHours = body.hours ?? req.query.hours ?? 9;
      const hours = String(rawHours).toLowerCase() === "all" ? 0 : Number(rawHours);
      // Capped per call so one click can't run long enough to be cut off by a
      // proxy timeout mid-batch. `remaining` in the response tells the UI
      // whether to offer another round.
      const limit = Math.min(Number(body.limit ?? req.query.limit ?? 25), 100);
      const dryRun = String(body.send ?? req.query.send ?? "") !== "true";

      if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365) {
        return res.status(400).json({ success: false, message: "hours must be 0 (all time) or between 1 and 8760." });
      }

      const { resendRecentFailedReceipts } = require("../services/paymentCompletion.service");
      const result = await resendRecentFailedReceipts({ hours, limit, dryRun, delayMs: 700 });

      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error("resendRecentWhatsApp error:", err);
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // ADMIN - manually re-trigger the WhatsApp receipt message, isolated from
  // DCC so a WhatsApp-only failure (bad phone, template not approved yet)
  // can be retried without re-running the DCC sync.
  resendWhatsApp: async (req, res) => {
    try {
      const { id } = req.params;
      const { isWhatsAppConfigured } = require("../services/whatsapp.service");
      const { isGupshupReceiptConfigured } = require("../services/gupshup.service");
      const { sendDonationWhatsAppReceipt } = require("../services/paymentCompletion.service");
      const donation = await donationModel.findById(id);
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      // Must match the provider sendDonationWhatsAppReceipt will actually use
      // (RECEIPT_WHATSAPP_PROVIDER, default gupshup). This gate used to check
      // WAPI_TOKEN unconditionally, which would refuse every resend on a
      // Gupshup-only setup even though the send would have worked.
      const provider = String(process.env.RECEIPT_WHATSAPP_PROVIDER || "gupshup").toLowerCase();
      const configured = provider === "gupshup" ? isGupshupReceiptConfigured() : isWhatsAppConfigured();
      if (!configured) {
        const missing =
          provider === "gupshup"
            ? "GUPSHUP_API_KEY / GUPSHUP_APP_NAME are"
            : "WAPI_TOKEN is";
        return res.status(200).json({
          message: `${missing} not configured on this server, so WhatsApp isn't connected yet. Nothing was sent.`,
          skipped: true,
        });
      }

      // force:true — this is a deliberate, human-initiated resend (admin
      // clicked the button), so it's allowed to send again even if a
      // receipt was already sent before. The atomic lock inside still
      // prevents a genuine double-click from sending twice.
      const result = await sendDonationWhatsAppReceipt(donation, { force: true });
      if (result.ok) {
        return res.status(200).json({ message: "WhatsApp receipt sent successfully" });
      }
      if (result.reason === "no_receipt_yet") {
        return res.status(200).json({
          message: "This donation doesn't have a DCC receipt number yet, so no WhatsApp message was sent (per policy, we never message a donor without the real receipt). Try 'Resend Receipt' first, then Resend WhatsApp again.",
          skipped: true,
        });
      }
      if (result.reason === "send_in_progress") {
        return res.status(200).json({
          message: "A WhatsApp send for this donation is already in progress (possibly from double-clicking). Please wait a moment and check whether it went through before resending.",
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
