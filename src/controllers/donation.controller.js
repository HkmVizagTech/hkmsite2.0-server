import { donations, donors, templeDevotees, festivalDonations } from "../db/tables.js";
import { isId } from "../db/pg.js";
import { castDonationForCreate, castDonationForUpdate, castFilter, defaultsToPersist } from "../domain/donationCast.js";
import { IST, istDayStart, istDayEnd } from "../config/timezone.js";
import { reconcilePendingDonations } from "../services/reconciliation.service.js";
import { findOrCreateDonor } from "../services/donor.service.js";
import {
  markDonationCompleted,
  sendDonationWhatsAppReceipt,
  resendRecentFailedReceipts,
} from "../services/paymentCompletion.service.js";
import { syncDonationToDcc as dccSync, isDccConfigured, cleanDccSeva } from "../services/dcc.service.js";
import { notifyDrmOfDonation } from "../services/drmNotify.service.js";
import {
  pushAndSendReceipt,
  pushResultMessage,
  setReceiptNumberAndSend,
  dccReceiptStatus,
  isSweepRunning,
  sweepDccReceipts,
} from "../services/dccSweep.service.js";
import { isWhatsAppConfigured } from "../services/whatsapp.service.js";
import { isGupshupReceiptConfigured } from "../services/gupshup.service.js";
import {
  EXCLUDE_DONATIONS_PAGE,
  NEEDS_ATTENTION_OR,
  SEVA_OR_TYPE_GENERAL,
  aggregate,
  sumCount,
  sumTotal,
  countGroups,
  castId,
  castNumber,
  istDay,
  istMonth,
  IST_ZONE,
  clampDate,
} from "../domain/donationQuery.js";

// The standalone /donations page family has its own admin and never shows in site-wide lists/stats.
function buildDateRangeMatch(from, to) {
  if (!from && !to) return {};
  const createdAt = {};
  if (from) {
    const d = istDayStart(from);
    if (d) createdAt.$gte = clampDate(d);
  }
  if (to) {
    const d = istDayEnd(to);
    if (d) createdAt.$lte = clampDate(d);
  }
  return Object.keys(createdAt).length ? { createdAt } : {};
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BY_NEWEST = { createdAt: -1, _id: 1 };

const LIST_FIELDS = [
  "donorName",
  "donorEmail",
  "donorMobile",
  "amount",
  "status",
  "date",
  "panNumber",
  "certificate",
  "wantPrasadam",
  "prasadamAddress",
  "transactionId",
  "razorpayOrderId",
  "razorpayPaymentId",
  "receiptNumber",
  "dccSyncStatus",
  "whatsappReceiptSentAt",
  "whatsappReceiptError",
  "sevaName",
  "type",
  "sourcePage",
  "utm",
  "createdAt",
  "manualEntry",
  "utrNumber",
  "manualPaymentMode",
  "manualEntryNote",
];

const PRASADAM_LIST_FIELDS = [
  "donorName",
  "donorEmail",
  "donorMobile",
  "amount",
  "status",
  "wantPrasadam",
  "prasadamAddress",
  "prasadamStatus",
  "prasadamCourier",
  "prasadamTrackingNumber",
  "prasadamDispatchedAt",
  "prasadamDeliveredAt",
  "prasadamNotes",
  "sevaName",
  "type",
  "sourcePage",
  "createdAt",
  "razorpayOrderId",
  "razorpayPaymentId",
  "receiptNumber",
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Fields PUT /donations/:id may change (the old handler passed the whole body to findByIdAndUpdate).
const UPDATABLE_FIELDS = [
  "donorName",
  "donorEmail",
  "donorMobile",
  "message",
  "panNumber",
  "sevakName",
  "sevaDate",
  "dob",
  "certificate",
  "wantPrasadam",
  "prasadamAddress",
];

const donationController = {
  stats: async (req, res) => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

      const completedBase = { ...EXCLUDE_DONATIONS_PAGE, status: "completed" };
      const needsAttentionFilter = { ...completedBase, $or: NEEDS_ATTENTION_OR };

      const [
        total,
        thisMonthTotal,
        lastMonthTotal,
        totalTransactions,
        totalDonors,
        monthlyAgg,
        sevaAgg,
        needsAttentionCount,
      ] = await Promise.all([
        sumCount(completedBase),
        sumTotal({ ...completedBase, createdAt: { $gte: startOfMonth } }),
        sumTotal({ ...completedBase, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
        donations.count(EXCLUDE_DONATIONS_PAGE),
        countGroups(
          completedBase,
          // Mongo parity: donations with no email all fall into one group; only an empty-string email falls back to the mobile.
          "CASE WHEN donor_email = '' THEN donor_mobile ELSE lower(donor_email) END"
        ),
        aggregate(
          { ...completedBase, createdAt: { $gte: twelveMonthsAgo } },
          `EXTRACT(YEAR FROM created_at AT TIME ZONE '${IST_ZONE}') AS y, EXTRACT(MONTH FROM created_at AT TIME ZONE '${IST_ZONE}') AS m, SUM(amount) AS amount, COUNT(*) AS count`,
          { groupBy: "y, m", orderBy: "y, m" }
        ),
        aggregate(completedBase, `${SEVA_OR_TYPE_GENERAL} AS k, SUM(amount) AS value, COUNT(*) AS count`, {
          groupBy: "k",
          orderBy: `value DESC, k COLLATE "C"`,
        }),
        donations.count(needsAttentionFilter),
      ]);

      const changePct = lastMonthTotal
        ? Number((((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100).toFixed(1))
        : null;

      res.status(200).json({
        success: true,
        stats: {
          totalCollected: total.total,
          totalCompletedCount: total.count,
          totalTransactions,
          totalDonors,
          thisMonth: { value: thisMonthTotal, changePct, label: `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}` },
          needsAttentionCount,
          monthly: monthlyAgg.map((m) => ({
            month: `${MONTH_NAMES[m.m - 1]} ${m.y}`,
            amount: m.amount,
            count: m.count,
          })),
          sevaWise: sevaAgg.map((s) => ({ name: s.k, value: s.value, count: s.count })),
        },
      });
    } catch (err) {
      console.error("donation stats error", err);
      res.status(500).json({ success: false, message: "Failed to fetch stats" });
    }
  },

  auditPending: async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
      const fix = req.query.fix === "true";
      const scope = req.query.scope || "seva";
      const statuses = req.query.statuses
        ? String(req.query.statuses)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["pending"];

      const { summary, results } = await reconcilePendingDonations({ limit, skip, fix, scope, statuses });

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

  getUtmStats: async (req, res) => {
    try {
      const { from, to } = req.query;
      const baseMatch = { ...EXCLUDE_DONATIONS_PAGE, status: "completed", ...buildDateRangeMatch(from, to) };

      const rows = await aggregate(
        baseMatch,
        "COALESCE(utm_campaign, '') AS campaign, COALESCE(utm_source, '') AS source, COALESCE(utm_medium, '') AS medium, SUM(amount) AS total_amount, COUNT(*) AS count",
        {
          groupBy: "campaign, source, medium",
          orderBy: `total_amount DESC, campaign COLLATE "C", source COLLATE "C", medium COLLATE "C"`,
        }
      );
      const stats = rows.map((r) => ({
        _id: {
          campaign: r.campaign === "" ? "direct" : r.campaign,
          source: r.source === "" ? "direct" : r.source,
          medium: r.medium === "" ? "none" : r.medium,
        },
        totalAmount: r.total_amount,
        count: r.count,
      }));

      const bySourcePage = await aggregate(
        baseMatch,
        "COALESCE(source_page, 'unknown') AS k, SUM(amount) AS total_amount, COUNT(*) AS count",
        { groupBy: "k", orderBy: `total_amount DESC, k COLLATE "C"` }
      );

      res.status(200).json({
        success: true,
        stats,
        bySourcePage: bySourcePage.map((r) => ({ sourcePage: r.k, totalAmount: r.total_amount, count: r.count })),
      });
    } catch (error) {
      console.error("donation.getUtmStats error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM stats" });
    }
  },

  getUtmTransactions: async (req, res) => {
    try {
      const { campaign, source, medium, sourcePage, from, to } = req.query;
      const match = { ...EXCLUDE_DONATIONS_PAGE, status: "completed", ...buildDateRangeMatch(from, to) };
      if (campaign) match["utm.campaign"] = campaign === "direct" ? { $in: [null, ""] } : campaign;
      if (source) match["utm.source"] = source === "direct" ? { $in: [null, ""] } : source;
      if (medium) match["utm.medium"] = medium === "none" ? { $in: [null, ""] } : medium;
      if (sourcePage) match.sourcePage = sourcePage === "unknown" ? { $in: [null, ""] } : sourcePage;

      const transactions = await donations.find(castFilter(match), {
        sort: BY_NEWEST,
        limit: 200,
        lean: true,
        fields: [
          "donorName",
          "donorEmail",
          "donorMobile",
          "amount",
          "status",
          "createdAt",
          "sourcePage",
          "utm",
          "receiptNumber",
          "razorpayPaymentId",
          "sevaName",
          "type",
        ],
      });

      res.status(200).json({ success: true, count: transactions.length, transactions });
    } catch (error) {
      console.error("donation.getUtmTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM transactions" });
    }
  },

  getReport: async (req, res) => {
    try {
      const { period = "today", from, to } = req.query;
      const now = new Date();

      // process.env.TZ is pinned to IST, so these Date getters are IST calendar days.
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

      let start,
        end,
        prevStart,
        prevEnd,
        granularity = "day";

      if (period === "today") {
        start = startOfDay(now);
        end = endOfDay(now);
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        prevStart = startOfDay(yest);
        prevEnd = endOfDay(yest);
      } else if (period === "yesterday") {
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        start = startOfDay(yest);
        end = endOfDay(yest);
        const dayBefore = new Date(yest);
        dayBefore.setDate(dayBefore.getDate() - 1);
        prevStart = startOfDay(dayBefore);
        prevEnd = endOfDay(dayBefore);
      } else if (period === "week") {
        const dow = now.getDay();
        const monday = new Date(now);
        monday.setDate(now.getDate() - ((dow + 6) % 7));
        start = startOfDay(monday);
        end = endOfDay(now);
        const prevMonday = new Date(monday);
        prevMonday.setDate(prevMonday.getDate() - 7);
        const prevSunday = new Date(monday);
        prevSunday.setDate(prevSunday.getDate() - 1);
        prevStart = startOfDay(prevMonday);
        prevEnd = endOfDay(prevSunday);
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
        if (!from || !to)
          return res.status(400).json({ success: false, message: "from and to are required for a custom period." });
        start = istDayStart(from);
        end = istDayEnd(to);
        if (!start || !end)
          return res.status(400).json({ success: false, message: "from and to must be valid dates (YYYY-MM-DD)." });
        const spanMs = end.getTime() - start.getTime();
        prevEnd = new Date(start.getTime() - 1);
        prevStart = new Date(prevEnd.getTime() - spanMs);
        granularity = spanMs > 45 * 24 * 60 * 60 * 1000 ? "month" : "day";
      } else {
        return res.status(400).json({ success: false, message: "Invalid period." });
      }

      const baseMatch = { ...EXCLUDE_DONATIONS_PAGE, createdAt: { $gte: clampDate(start), $lte: clampDate(end) } };
      const completedMatch = { ...baseMatch, status: "completed" };
      const prevCompletedMatch = {
        ...EXCLUDE_DONATIONS_PAGE,
        status: "completed",
        createdAt: { $gte: clampDate(prevStart), $lte: clampDate(prevEnd) },
      };
      const bucket = granularity === "month" ? istMonth("created_at") : istDay("created_at");

      const [summary, prevSummary, sevaAgg, statusAgg, seriesAgg] = await Promise.all([
        sumCount(completedMatch),
        sumCount(prevCompletedMatch),
        aggregate(completedMatch, `${SEVA_OR_TYPE_GENERAL} AS k, SUM(amount) AS amount, COUNT(*) AS count`, {
          groupBy: "k",
          orderBy: `amount DESC, k COLLATE "C"`,
          limit: 15,
        }),
        aggregate(baseMatch, "status AS k, SUM(amount) AS amount, COUNT(*) AS count, MIN(id) AS first_id", {
          groupBy: "k",
          orderBy: "first_id",
        }),
        aggregate(completedMatch, `${bucket} AS k, SUM(amount) AS amount, COUNT(*) AS count`, {
          groupBy: "k",
          orderBy: "k",
        }),
      ]);

      const { total, count } = summary;
      const percentChange =
        prevSummary.total > 0 ? Number((((total - prevSummary.total) / prevSummary.total) * 100).toFixed(1)) : null;

      res.status(200).json({
        success: true,
        period,
        range: { start, end },
        summary: {
          totalAmount: total,
          count,
          avgDonation: count > 0 ? Math.round(total / count) : 0,
          previousPeriod: { totalAmount: prevSummary.total, count: prevSummary.count },
          percentChange,
        },
        sevaBreakdown: sevaAgg.map((s) => ({ name: s.k, amount: s.amount, count: s.count })),
        statusBreakdown: statusAgg.map((s) => ({ status: s.k, amount: s.amount, count: s.count })),
        series: seriesAgg.map((s) => ({ date: s.k, amount: s.amount, count: s.count })),
        granularity,
      });
    } catch (error) {
      console.error("donation.getReport error:", error);
      res.status(500).json({ success: false, message: "Failed to generate report" });
    }
  },

  createManual: async (req, res) => {
    try {
      const {
        donorName,
        donorEmail,
        donorMobile,
        amount,
        type,
        sevaName,
        utrNumber,
        manualPaymentMode,
        paymentDate,
        manualEntryNote,
        panNumber,
        certificate,
        wantPrasadam,
        prasadamAddress,
        sevakName,
        dob,
        devoteeId,
        razorpayPaymentId: gatewayPaymentId,
        dccEnrolledById: dccEnrolledByIdRaw,
        // The seva DRM's caller picked, as DCC wants it (see cleanDccSeva).
        dccSevaCategory,
        dccSevaSubCategory,
        dccSevaSubCategoryCode,
      } = req.body;

      // Used only when the switch is on and the three values are well-formed; otherwise this is null and
      // nothing below behaves any differently.
      const dccSeva =
        process.env.DCC_USE_DRM_SEVA === "true"
          ? cleanDccSeva({ category: dccSevaCategory, subCategory: dccSevaSubCategory, code: dccSevaSubCategoryCode })
          : null;

      const name = String(donorName || "").trim();
      const amt = Number(amount);
      const utr = String(utrNumber || "").trim();

      if (!name) return res.status(400).json({ success: false, message: "Donor name is required." });
      if (!Number.isFinite(amt) || amt <= 0)
        return res.status(400).json({ success: false, message: "A valid amount is required." });
      if (!utr)
        return res
          .status(400)
          .json({ success: false, message: "UTR / reference number is required to record a manual payment." });
      if (!donorEmail && !donorMobile)
        return res
          .status(400)
          .json({ success: false, message: "Please provide at least an email or mobile number for the receipt." });

      const validModes = ["upi", "bank", "cash", "cheque"];
      const mode = validModes.includes(manualPaymentMode) ? manualPaymentMode : "bank";

      let dccEnrolledById;
      if (devoteeId) {
        // mongoose.isValidObjectId accepted numbers too, and the findById then failed the cast.
        const devotee =
          isId(devoteeId) || typeof devoteeId === "number"
            ? await templeDevotees.findById(castId(devoteeId, "templeDevotee"), { lean: true })
            : null;
        if (devotee?.dccEnrolledById != null) dccEnrolledById = devotee.dccEnrolledById;
      }
      if (
        dccEnrolledById == null &&
        Number.isFinite(Number(dccEnrolledByIdRaw)) &&
        dccEnrolledByIdRaw !== "" &&
        dccEnrolledByIdRaw != null
      ) {
        dccEnrolledById = Number(dccEnrolledByIdRaw);
      }

      const existingWithUtr = await donations.findOne({ utrNumber: utr }, { lean: true });
      if (existingWithUtr) {
        return res.status(409).json({
          success: false,
          message: `This UTR is already recorded against a donation from ${existingWithUtr.donorName} (₹${existingWithUtr.amount}, ${new Date(existingWithUtr.createdAt).toLocaleDateString("en-IN", { timeZone: IST })}).`,
        });
      }

      const donation = await donations.insert(
        castDonationForCreate({
          donorName: name,
          donorEmail: donorEmail ? String(donorEmail).trim().toLowerCase() : undefined,
          donorMobile: donorMobile ? String(donorMobile).trim() : undefined,
          amount: amt,
          type: type || "Manual Entry",
          sevaName: sevaName || undefined,
          // Kept on the donation so a retry uses the same seva.
          ...(dccSeva
            ? {
                dccSevaCategory: dccSeva.sevaCategory,
                dccSevaSubCategory: dccSeva.sevaSubCategory,
                dccSevaSubCategoryCode: String(dccSeva.sevaSubCategoryCode),
              }
            : {}),
          sourcePage: "admin-manual",
          status: "pending",
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
          // Kept for 80G as well as prasadam: the receipt and DCC both read this address.
          prasadamAddress: wantPrasadam || certificate ? prasadamAddress : undefined,
          transactionId: gatewayPaymentId ? String(gatewayPaymentId).trim() : undefined,
          sevakName: sevakName || undefined,
          dob: dob || undefined,
        })
      );

      if (donation.donorMobile) {
        try {
          const raisedByPreacherId = req.user?.role === "preacher" ? req.user.userId : undefined;
          const donorRecord = await findOrCreateDonor({
            mobile: donation.donorMobile,
            name: donation.donorName,
            email: donation.donorEmail,
            raisedByPreacherId,
          });
          await donations.updateById(donation._id, { donorRecordId: donorRecord._id, donorId: donorRecord.donorId });
        } catch (e) {
          console.error("Donor record linking failed (non-fatal):", e && e.message ? e.message : e);
        }
      }

      await markDonationCompleted({ donationId: donation._id });

      try {
        await dccSync(await donations.findById(donation._id), utr, { seva: dccSeva });
      } catch (e) {
        console.error("Manual entry DCC sync failed:", e && e.message ? e.message : e);
      }
      try {
        await sendDonationWhatsAppReceipt(await donations.findById(donation._id));
      } catch (e) {
        console.error("Manual entry WhatsApp receipt failed:", e && e.message ? e.message : e);
      }

      // DRM push goes last so the receipt number is included. Never throws.
      try {
        notifyDrmOfDonation(donation._id, { reason: "manual_entry" }).catch(() => undefined);
      } catch (e) {
        console.warn("DRM push not started (non-fatal):", e && e.message ? e.message : e);
      }

      const final = await donations.findById(donation._id);
      res.status(201).json({ success: true, donation: final });
    } catch (error) {
      console.error("donation.createManual error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to record manual donation" });
    }
  },

  completeManualPending: async (req, res) => {
    try {
      const { utrNumber, manualPaymentMode, manualEntryNote } = req.body;
      const utr = String(utrNumber || "").trim();
      if (!utr) return res.status(400).json({ success: false, message: "UTR / reference number is required." });

      const donation = await donations.findById(castId(req.params.id));
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });
      if (donation.status === "completed") {
        return res.status(409).json({ success: false, message: "This donation is already completed." });
      }

      const existingWithUtr = await donations.findOne({ utrNumber: utr, _id: { $ne: donation._id } }, { lean: true });
      if (existingWithUtr) {
        return res.status(409).json({
          success: false,
          message: `This UTR is already recorded against another donation (${existingWithUtr.donorName}, ₹${existingWithUtr.amount}).`,
        });
      }

      const validModes = ["upi", "bank", "cash", "cheque"];
      const mode = validModes.includes(manualPaymentMode) ? manualPaymentMode : "upi";

      await donations.updateById(
        donation._id,
        castDonationForUpdate({
          manualEntry: true,
          utrNumber: utr,
          manualPaymentMode: mode,
          manualEntryNote: manualEntryNote || undefined,
          manualEnteredBy: req.user?.userId || undefined,
        })
      );

      await markDonationCompleted({ donationId: donation._id });

      try {
        await dccSync(await donations.findById(donation._id), utr);
      } catch (e) {
        console.error("Manual completion DCC sync failed:", e && e.message ? e.message : e);
      }
      try {
        await sendDonationWhatsAppReceipt(await donations.findById(donation._id));
      } catch (e) {
        console.error("Manual completion WhatsApp receipt failed:", e && e.message ? e.message : e);
      }

      try {
        notifyDrmOfDonation(donation._id, { reason: "manual_entry" }).catch(() => undefined);
      } catch (e) {
        console.warn("DRM push not started (non-fatal):", e && e.message ? e.message : e);
      }

      const final = await donations.findById(donation._id);
      res.status(200).json({ success: true, donation: final });
    } catch (error) {
      console.error("donation.completeManualPending error:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to complete donation" });
    }
  },

  list: async (req, res) => {
    try {
      const { type, status, date, festivalId, festivalSlug, q, from, to, minAmount, maxAmount } = req.query;
      const filter = { ...EXCLUDE_DONATIONS_PAGE };
      if (type) filter.type = type;
      if (status === "needs_attention") {
        filter.status = "completed";
        filter.$or = NEEDS_ATTENTION_OR;
      } else if (status === "unpaid") {
        filter.status = { $in: ["pending", "failed"] };
      } else if (status && status !== "all") {
        filter.status = status;
      }
      if (date) {
        const start = istDayStart(date);
        const end = istDayEnd(date);
        if (start && end) filter.date = { $gte: clampDate(start), $lte: clampDate(end) };
      }
      if (from) {
        const d = istDayStart(from);
        if (d) {
          filter.date = filter.date || {};
          filter.date.$gte = clampDate(d);
        }
      }
      if (to) {
        const d = istDayEnd(to);
        if (d) {
          filter.date = filter.date || {};
          filter.date.$lte = clampDate(d);
        }
      }
      if (festivalId) filter.festivalId = festivalId;
      if (festivalSlug) filter.festivalSlug = festivalSlug;
      if (minAmount) filter.amount = Object.assign({}, filter.amount, { $gte: castNumber(minAmount) });
      if (maxAmount) filter.amount = Object.assign({}, filter.amount, { $lte: castNumber(maxAmount) });
      if (q) {
        const re = new RegExp(String(q), "i");
        const searchOr = [
          { donorName: re },
          { donorEmail: re },
          { donorMobile: re },
          { transactionId: re },
          { razorpayOrderId: re },
          { razorpayPaymentId: re },
          { utrNumber: re },
        ];
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
          delete filter.$or;
        } else {
          filter.$or = searchOr;
        }
      }

      const toInt = (value, fallback) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : fallback;
      };
      const page = Math.max(1, toInt(req.query.page, 1));

      // Browsing is capped at 200 rows/page; CSV export mode may ask for up to 1000 per page.
      const MAX_BROWSE_LIMIT = 200;
      const MAX_EXPORT_LIMIT = 1000;
      const isExport = String(req.query.export || "") === "1";
      const limit = Math.min(isExport ? MAX_EXPORT_LIMIT : MAX_BROWSE_LIMIT, Math.max(1, toInt(req.query.limit, 20)));
      const skip = (page - 1) * limit;

      const castedFilter = castFilter(filter);
      const [total, rows, totalAmount] = await Promise.all([
        donations.count(castedFilter),
        donations.find(castedFilter, { sort: BY_NEWEST, skip, limit, fields: LIST_FIELDS, lean: true }),
        sumTotal(filter),
      ]);

      res.status(200).json({ donations: rows, total, page, limit, totalAmount });
    } catch (err) {
      console.error("donation list error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  get: async (req, res) => {
    try {
      const donation = await donations.findById(castId(req.params.id));
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      res.status(200).json({ donation });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      const {
        donorName,
        donorEmail,
        donorMobile,
        amount,
        type,
        message,
        transactionId,
        festivalId,
        festivalSlug,
        panNumber,
        certificate,
        wantPrasadam,
        prasadamAddress,
        razorpayOrderId,
      } = req.body;
      if (!donorName || !amount) {
        return res.status(400).json({ message: "Name and amount are required" });
      }
      let resolvedFestivalId = festivalId;
      if (!resolvedFestivalId && festivalSlug) {
        try {
          const fest = await festivalDonations.findOne({ slug: festivalSlug }, { fields: ["_id"] });
          if (fest) resolvedFestivalId = fest._id;
        } catch (err) {
          console.warn("Could not resolve festivalSlug to festivalId", festivalSlug, err);
        }
      }
      const doc = castDonationForCreate({
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
        status: "pending",
      });
      const donation = await donations.insert(doc);
      res.status(201).json({ message: "Donation created", donation });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const body = req.body || {};
      const input = {};
      for (const key of UPDATABLE_FIELDS) if (body[key] !== undefined) input[key] = body[key];
      const patch = castDonationForUpdate(input);
      // donor_name is NOT NULL in Postgres; Mongo stored the null.
      if (patch.donorName === null) delete patch.donorName;
      const donation = await donations.updateById(castId(id), patch);
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      res.status(200).json({ message: "Donation updated", donation });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      await donations.deleteById(castId(req.params.id));
      res.status(200).json({ message: "Donation deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  resendReceipt: async (req, res) => {
    try {
      const { id } = req.params;

      const donation = await donations.findById(castId(id));
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      if (!isDccConfigured()) {
        return res.status(200).json({
          message:
            "DCC_API_KEY is not configured on this server, so no receipt system is connected yet. Nothing was sent.",
          skipped: true,
        });
      }

      const result = await pushAndSendReceipt(id);
      const message = pushResultMessage(result);
      if (result.receiptNumber) {
        return res.status(200).json({ message, receiptNumber: result.receiptNumber, whatsapp: result.whatsapp });
      }
      return res.status(502).json({ message, error: message });
    } catch (err) {
      console.error("Resend receipt error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  patchReceiptNumber: async (req, res) => {
    try {
      const { receiptNumber } = req.body;
      const clean = String(receiptNumber || "").trim();
      if (!clean) return res.status(400).json({ success: false, message: "receiptNumber is required." });

      const result = await setReceiptNumberAndSend(req.params.id, clean);
      if (!result) return res.status(404).json({ success: false, message: "Donation not found." });
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error("patchReceiptNumber error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  dccStatus: async (req, res) => {
    try {
      const status = await dccReceiptStatus({ includeOld: req.query.includeOld === "true" });
      res.status(200).json({ success: true, configured: isDccConfigured(), running: isSweepRunning(), ...status });
    } catch (err) {
      console.error("dccStatus error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  dccPushAll: async (req, res) => {
    try {
      if (!isDccConfigured())
        return res.status(400).json({ success: false, message: "DCC is not configured on this server." });
      if (isSweepRunning()) return res.status(202).json({ success: true, message: "A push is already running." });
      sweepDccReceipts({ limit: 200, ignoreBackoff: true })
        .then((s) =>
          console.log(
            `[dcc-sweep] admin push: pushed ${s.pushed}, ${s.receipts} receipt(s), ${s.whatsappSent} WhatsApp sent, ${s.failed} failing`
          )
        )
        .catch((e) => console.error("[dcc-sweep] admin push failed:", e && e.message ? e.message : e));
      res.status(202).json({ success: true, message: "Pushing to DCC now." });
    } catch (err) {
      console.error("dccPushAll error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // Completed donations whose DCC sync failed or DCC already has the transaction, with no receipt number captured.
  needsManualReceipt: async (req, res) => {
    try {
      const rows = await donations.find(
        {
          status: "completed",
          receiptNumber: { $in: [null, ""] },
          $or: [{ dccSyncStatus: "failed" }, { dccSyncError: { $regex: "transaction details exist", $options: "i" } }],
        },
        {
          sort: BY_NEWEST,
          limit: 200,
          lean: true,
          fields: [
            "donorName",
            "donorEmail",
            "donorMobile",
            "amount",
            "sevaName",
            "type",
            "createdAt",
            "dccSyncStatus",
            "dccSyncError",
            "razorpayPaymentId",
            "utrNumber",
          ],
        }
      );

      res.status(200).json({ success: true, count: rows.length, donations: rows });
    } catch (err) {
      console.error("needsManualReceipt error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // Groups completed donations without a donor record by mobile and links/creates one Donor per number.
  backfillDonors: async (req, res) => {
    try {
      const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const execute = req.query.execute === "true";
      // In execute mode processed groups drop out of the filter, so the next batch is always at skip 0.
      const skip = execute ? 0 : Math.max(0, parseInt(req.query.skip, 10) || 0);

      const groups = await aggregate(
        { status: "completed", donorMobile: { $exists: true, $ne: "" }, donorRecordId: null },
        `donor_mobile AS k,
         (array_agg(donor_name ORDER BY created_at DESC, id))[1] AS name,
         (array_agg(donor_email ORDER BY created_at DESC, id))[1] AS email,
         COUNT(*) AS count`,
        { groupBy: "donor_mobile", orderBy: `k COLLATE "C"`, limit, offset: skip }
      );

      const results = [];

      for (const g of groups) {
        const entry = { mobile: g.k, name: g.name, email: g.email, donationCount: g.count };
        if (execute) {
          try {
            const donor = await findOrCreateDonor({ mobile: g.k, name: g.name, email: g.email });
            const linked = await donations.updateMany(
              { donorMobile: g.k, status: "completed", donorRecordId: null },
              { donorRecordId: donor._id, donorId: donor.donorId }
            );
            entry.donorId = donor.donorId;
            entry.donationsLinked = linked;
            entry.action = "LINKED";
          } catch (err) {
            entry.action = "ERROR";
            entry.error = err.message;
          }
        } else {
          entry.action = "WOULD_LINK";
        }
        results.push(entry);
      }

      res.status(200).json({
        success: true,
        mode: execute ? "EXECUTED" : "PREVIEW ONLY — nothing created or linked",
        groupsInThisBatch: groups.length,
        results,
      });
    } catch (err) {
      console.error("backfillDonors error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  backfillDccDonorNumbers: async (req, res) => {
    try {
      const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const execute = req.query.execute === "true";

      const pending = await donors.find({ dccDonorNumber: null }, { sort: { _id: 1 }, limit, lean: true });

      const results = [];
      for (const donor of pending) {
        const rows = await aggregate(
          {
            donorRecordId: donor._id,
            $raw: ["(jsonb_exists(dcc_response, 'DonorNumber') AND dcc_response->'DonorNumber' <> 'null'::jsonb)", []],
          },
          "dcc_response->'DonorNumber' AS dn",
          { orderBy: "created_at, id", limit: 1 }
        );

        const entry = { donorId: donor.donorId, name: donor.name, mobile: donor.mobile };
        if (!rows.length) {
          entry.action = "NO_SYNCED_DONATION_FOUND";
        } else {
          const dccDonorNumber = rows[0].dn;
          entry.dccDonorNumber = dccDonorNumber;
          if (execute) {
            await donors.updateById(donor._id, { dccDonorNumber });
            entry.action = "BACKFILLED";
          } else {
            entry.action = "WOULD_BACKFILL";
          }
        }
        results.push(entry);
      }

      res.status(200).json({
        success: true,
        mode: execute ? "EXECUTED" : "PREVIEW ONLY — nothing changed",
        checkedThisBatch: pending.length,
        results,
      });
    } catch (err) {
      console.error("backfillDccDonorNumbers error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  // Completed donations with a real receipt number but no delivered WhatsApp receipt.
  needsWhatsApp: async (req, res) => {
    try {
      const rows = await donations.find(
        {
          status: "completed",
          receiptNumber: { $nin: [null, ""] },
          $or: [{ whatsappReceiptSentAt: null }, { whatsappDeliveryStatus: "failed" }],
        },
        {
          sort: BY_NEWEST,
          limit: 200,
          lean: true,
          fields: [
            "donorName",
            "donorEmail",
            "donorMobile",
            "amount",
            "sevaName",
            "type",
            "createdAt",
            "receiptNumber",
            "whatsappReceiptError",
            "whatsappReceiptSentAt",
            "whatsappProvider",
            "whatsappDeliveryStatus",
          ],
        }
      );

      res.status(200).json({ success: true, count: rows.length, donations: rows });
    } catch (err) {
      console.error("needsWhatsApp error:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  resendRecentWhatsApp: async (req, res) => {
    try {
      const body = req.body || {};
      const rawHours = body.hours ?? req.query.hours ?? 9;
      const hours = String(rawHours).toLowerCase() === "all" ? 0 : Number(rawHours);
      const limit = Math.min(Number(body.limit ?? req.query.limit ?? 25), 100);
      const dryRun = String(body.send ?? req.query.send ?? "") !== "true";

      if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365) {
        return res.status(400).json({ success: false, message: "hours must be 0 (all time) or between 1 and 8760." });
      }

      const result = await resendRecentFailedReceipts({ hours, limit, dryRun, delayMs: 700 });

      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error("resendRecentWhatsApp error:", err);
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  },

  resendWhatsApp: async (req, res) => {
    try {
      const { id } = req.params;

      const donation = await donations.findById(castId(id));
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      const provider = String(process.env.RECEIPT_WHATSAPP_PROVIDER || "gupshup").toLowerCase();
      const configured = provider === "gupshup" ? isGupshupReceiptConfigured() : isWhatsAppConfigured();
      if (!configured) {
        const missing = provider === "gupshup" ? "GUPSHUP_API_KEY / GUPSHUP_APP_NAME are" : "WAPI_TOKEN is";
        return res.status(200).json({
          message: `${missing} not configured on this server, so WhatsApp isn't connected yet. Nothing was sent.`,
          skipped: true,
        });
      }

      // force: a deliberate admin resend may send again; the atomic lock inside still blocks a double-click.
      const result = await sendDonationWhatsAppReceipt(donation, { force: true });
      if (result.ok) {
        return res.status(200).json({ message: "WhatsApp receipt sent successfully" });
      }
      if (result.reason === "no_receipt_yet") {
        return res.status(200).json({
          message:
            "This donation doesn't have a DCC receipt number yet, so no WhatsApp message was sent (per policy, we never message a donor without the real receipt). Try 'Resend Receipt' first, then Resend WhatsApp again.",
          skipped: true,
        });
      }
      if (result.reason === "send_in_progress") {
        return res.status(200).json({
          message:
            "A WhatsApp send for this donation is already in progress (possibly from double-clicking). Please wait a moment and check whether it went through before resending.",
          skipped: true,
        });
      }
      return res.status(502).json({ message: result.reason || "WhatsApp send failed", error: result.error });
    } catch (err) {
      console.error("Resend WhatsApp error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // whatsappReceiptSentAt set but no receipt number (pre-policy sends); ?fix=true clears the field.
  whatsappAudit: async (req, res) => {
    try {
      const query = {
        whatsappReceiptSentAt: { $ne: null },
        $or: [{ receiptNumber: null }, { receiptNumber: "" }],
      };
      const stale = await donations.find(query, {
        sort: { _id: 1 },
        lean: true,
        fields: [
          "_id",
          "donorName",
          "donorMobile",
          "amount",
          "sourcePage",
          "sevaName",
          "whatsappReceiptSentAt",
          "dccSyncStatus",
        ],
      });

      if (req.query.fix === "true" && stale.length > 0) {
        await donations.updateMany(query, { $set: { whatsappReceiptSentAt: null } });
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

  // Maha Prasadam: completed donations with wantPrasadam, excluding the /donations page family.
  listPrasadamRequests: async (req, res) => {
    try {
      const { status, q, seva, sourcePage } = req.query;
      const filter = {
        wantPrasadam: true,
        status: "completed",
        ...EXCLUDE_DONATIONS_PAGE,
        ...buildDateRangeMatch(req.query.from, req.query.to),
      };

      let statusOr = null;
      if (status && status !== "all") {
        if (status === "not_dispatched" || status === "pending") {
          // Old records predating tracking have no prasadamStatus and count as pending.
          statusOr = [{ prasadamStatus: "pending" }, { prasadamStatus: null }];
        } else {
          filter.prasadamStatus = status;
        }
      }

      if (seva) filter.sevaName = seva;
      if (sourcePage) filter.sourcePage = sourcePage;

      if (q) {
        const re = new RegExp(escapeRegex(String(q)), "i");
        const searchOr = [
          { donorName: re },
          { donorMobile: re },
          { donorEmail: re },
          { "prasadamAddress.pincode": re },
          { prasadamTrackingNumber: re },
        ];
        if (statusOr) {
          filter.$and = [{ $or: statusOr }, { $or: searchOr }];
        } else {
          filter.$or = searchOr;
        }
      } else if (statusOr) {
        filter.$or = statusOr;
      }

      const page = Math.max(1, parseInt(req.query.page || "1", 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "20", 10)));
      const skip = (page - 1) * limit;
      // Mongoose ignored a NaN skip or limit.
      const pageOpts = { skip: Number.isNaN(skip) ? 0 : skip, limit: Number.isNaN(limit) ? undefined : limit };

      const optMatch = { wantPrasadam: true, status: "completed", ...EXCLUDE_DONATIONS_PAGE };

      const castedFilter = castFilter(filter);
      const [total, requests, counts, sevaAgg, pageAgg] = await Promise.all([
        donations.count(castedFilter),
        donations.find(castedFilter, { sort: BY_NEWEST, ...pageOpts, fields: PRASADAM_LIST_FIELDS, lean: true }),
        aggregate(optMatch, "prasadam_status AS k, COUNT(*) AS count", { groupBy: "k" }),
        aggregate(optMatch, "seva_name AS k", { groupBy: "k", orderBy: `k COLLATE "C"` }),
        aggregate(optMatch, "source_page AS k", { groupBy: "k", orderBy: `k COLLATE "C"` }),
      ]);

      const badgeCounts = { all: 0, pending: 0, dispatched: 0, delivered: 0, cancelled: 0 };
      for (const row of counts) {
        const key = row.k || "pending";
        if (badgeCounts[key] !== undefined) badgeCounts[key] += row.count;
        badgeCounts.all += row.count;
      }

      res.status(200).json({
        requests,
        total,
        page,
        limit,
        badgeCounts,
        filterOptions: {
          sevas: sevaAgg.map((r) => r.k).filter(Boolean),
          pages: pageAgg.map((r) => r.k).filter(Boolean),
        },
      });
    } catch (err) {
      console.error("donation.listPrasadamRequests error:", err);
      res.status(500).json({ success: false, message: "Failed to fetch prasadam requests" });
    }
  },

  updatePrasadamStatus: async (req, res) => {
    try {
      const { id } = req.params;
      const { prasadamStatus, prasadamCourier, prasadamTrackingNumber, prasadamNotes } = req.body || {};

      const PRASADAM_STATUSES = ["pending", "dispatched", "delivered", "cancelled"];
      if (!PRASADAM_STATUSES.includes(prasadamStatus)) {
        return res.status(400).json({
          success: false,
          message: "prasadamStatus must be one of: pending, dispatched, delivered, cancelled",
        });
      }

      const donation = await donations.findById(castId(id));
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });
      if (!donation.wantPrasadam) {
        return res
          .status(400)
          .json({ success: false, message: "This donation has no Maha Prasadam request to track." });
      }

      const patch = { prasadamStatus };
      if (prasadamCourier !== undefined) patch.prasadamCourier = String(prasadamCourier || "").trim();
      if (prasadamTrackingNumber !== undefined)
        patch.prasadamTrackingNumber = String(prasadamTrackingNumber || "").trim();
      if (prasadamNotes !== undefined) patch.prasadamNotes = String(prasadamNotes || "").trim();

      const now = new Date();
      const unset = [];
      if (prasadamStatus === "dispatched") {
        patch.prasadamDispatchedAt = now;
        unset.push("prasadamDeliveredAt");
      } else if (prasadamStatus === "delivered") {
        if (!donation.prasadamDispatchedAt) patch.prasadamDispatchedAt = now;
        patch.prasadamDeliveredAt = now;
      } else {
        unset.push("prasadamDispatchedAt", "prasadamDeliveredAt");
      }

      // Mongoose save() wrote nothing (and left updatedAt alone) when no value actually changed.
      const same = (a, b) => (a ?? null) === (b ?? null) || (a instanceof Date && b instanceof Date && +a === +b);
      const changed =
        Object.keys(patch).some((k) => !same(patch[k], donation[k])) || unset.some((k) => donation[k] != null);
      let updated = donation;
      if (changed) {
        const raw = await donations.findById(donation._id, { lean: true });
        updated = await donations.updateById(donation._id, {
          ...defaultsToPersist(raw, donation, ["utm", "prasadamAddress"]),
          ...patch,
          ...(unset.length ? { $unset: unset } : {}),
        });
      }
      res.status(200).json({ success: true, message: `Prasadam request marked ${prasadamStatus}`, donation: updated });
    } catch (err) {
      console.error("donation.updatePrasadamStatus error:", err);
      res.status(500).json({ success: false, message: err.message || "Failed to update prasadam status" });
    }
  },

  exportPrasadamCsv: async (req, res) => {
    try {
      const { status, q, seva, sourcePage } = req.query;
      const filter = {
        wantPrasadam: true,
        status: "completed",
        ...EXCLUDE_DONATIONS_PAGE,
        ...buildDateRangeMatch(req.query.from, req.query.to),
      };

      if (status && status !== "all") {
        if (status === "not_dispatched" || status === "pending") {
          filter.$or = [{ prasadamStatus: "pending" }, { prasadamStatus: null }];
        } else {
          filter.prasadamStatus = status;
        }
      }

      if (seva) filter.sevaName = seva;
      if (sourcePage) filter.sourcePage = sourcePage;

      if (q) {
        const re = new RegExp(escapeRegex(String(q)), "i");
        // Deliberately replaces the status $or above (existing behaviour, kept for identical exports).
        filter.$or = [
          { donorName: re },
          { donorMobile: re },
          { donorEmail: re },
          { "prasadamAddress.pincode": re },
          { prasadamTrackingNumber: re },
        ];
      }

      const rows = await donations.find(castFilter(filter), {
        sort: BY_NEWEST,
        limit: 5000,
        lean: true,
        fields: [
          "donorName",
          "donorEmail",
          "donorMobile",
          "amount",
          "sevaName",
          "type",
          "sourcePage",
          "prasadamAddress",
          "prasadamStatus",
          "prasadamCourier",
          "prasadamTrackingNumber",
          "prasadamDispatchedAt",
          "prasadamDeliveredAt",
          "prasadamNotes",
          "receiptNumber",
          "razorpayOrderId",
          "razorpayPaymentId",
          "createdAt",
        ],
      });

      const csvEscape = (val) => {
        const s = val === null || val === undefined ? "" : String(val);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const formatAddress = (a) => {
        if (!a) return "";
        return [a.doorNo, a.house, a.street, a.area, a.city, a.state, a.pincode, a.country].filter(Boolean).join(", ");
      };

      const statusLabel = (r) => r.prasadamStatus || "pending";

      const headers = [
        "Donor Name",
        "Mobile",
        "Email",
        "Amount",
        "Delivery Address",
        "Seva",
        "Source Page",
        "Prasadam Status",
        "Courier",
        "Tracking Number",
        "Dispatched At",
        "Delivered At",
        "Donated On",
        "Notes",
        "Receipt Number",
        "Payment ID",
      ];
      const istTime = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "");
      const csv = [
        headers.join(","),
        ...rows.map((r) =>
          [
            r.donorName || "",
            r.donorMobile || "",
            r.donorEmail || "",
            r.amount,
            formatAddress(r.prasadamAddress),
            r.sevaName || r.type || "",
            r.sourcePage || "",
            statusLabel(r),
            r.prasadamCourier || "",
            r.prasadamTrackingNumber || "",
            istTime(r.prasadamDispatchedAt),
            istTime(r.prasadamDeliveredAt),
            istTime(r.createdAt),
            r.prasadamNotes || "",
            r.receiptNumber || "",
            r.razorpayPaymentId || r.razorpayOrderId || "",
          ]
            .map(csvEscape)
            .join(",")
        ),
      ].join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      const stamp = new Date().toLocaleDateString("en-CA", { timeZone: IST });
      res.setHeader("Content-Disposition", `attachment; filename="prasadam-dispatch-${stamp}.csv"`);
      res.status(200).send(csv);
    } catch (err) {
      console.error("donation.exportPrasadamCsv error:", err);
      res.status(500).json({ success: false, message: "Failed to export prasadam CSV" });
    }
  },
};

export { donationController };
