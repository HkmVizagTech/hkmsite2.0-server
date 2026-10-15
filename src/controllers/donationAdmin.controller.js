import fs from "node:fs";
import { donations } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { createRazorpayInstance } from "./payment.controller.js";
import { completeDonation } from "../services/paymentCompletion.service.js";
import { castFilter, defaultsToPersist } from "../domain/donationCast.js";
import { IST, istDayStart, istDayEnd } from "../config/timezone.js";
import * as prasadamService from "../services/prasadam.service.js";
import {
  dccReceiptStatus,
  isSweepRunning,
  sweepDccReceipts,
  pushAndSendReceipt,
  pushResultMessage,
  setReceiptNumberAndSend,
} from "../services/dccSweep.service.js";
import { isDccConfigured } from "../services/dcc.service.js";
import {
  DONATIONS_DOMAIN_PATTERN,
  NEEDS_ATTENTION_OR,
  SEVA_OR_TYPE_GENERAL,
  aggregate,
  sumCount,
  sumTotal,
  countGroups,
  castId,
  istDay,
  clampDate,
} from "../domain/donationQuery.js";

// Scope of the standalone /donations page family (plus two legacy shapes). Repo-style filter,
// also handed to dccSweep.service as `scope`.
const DONATIONS_PAGE_FILTER = {
  $or: [{ sourcePage: DONATIONS_DOMAIN_PATTERN }, { sourcePage: "/donations" }, { type: "Donation" }],
};

const PRASADAM_TRACKED = [
  "prasadamStatus",
  "prasadamCourier",
  "prasadamTrackingNumber",
  "prasadamNotes",
  "prasadamDispatchedAt",
  "prasadamDeliveredAt",
];

const SUCCESS_STATUSES = ["completed"];
const BY_NEWEST = { createdAt: -1, _id: 1 };

function buildDateRangeMatch(startDate, endDate) {
  if (!startDate && !endDate) return {};
  const createdAt = {};
  if (startDate) {
    const d = istDayStart(startDate);
    if (d) createdAt.$gte = clampDate(d);
  }
  if (endDate) {
    const d = istDayEnd(endDate);
    if (d) createdAt.$lte = clampDate(d);
  }
  return Object.keys(createdAt).length ? { createdAt } : {};
}

const withUtmFilters = (match, { campaign, source, medium }) => {
  if (campaign) match["utm.campaign"] = campaign === "direct" ? { $in: [null, ""] } : campaign;
  if (source) match["utm.source"] = source === "direct" ? { $in: [null, ""] } : source;
  if (medium) match["utm.medium"] = medium === "none" ? { $in: [null, ""] } : medium;
  return match;
};

const utmGroupRows = (rows) =>
  rows.map((r) => ({
    _id: {
      campaign: r.campaign === "" ? "direct" : r.campaign,
      source: r.source === "" ? "direct" : r.source,
      medium: r.medium === "" ? "none" : r.medium,
    },
    totalAmount: r.total_amount,
    count: r.count,
  }));

const UTM_GROUP_SELECT =
  "COALESCE(utm_campaign, '') AS campaign, COALESCE(utm_source, '') AS source, COALESCE(utm_medium, '') AS medium, SUM(amount) AS total_amount, COUNT(*) AS count";
const UTM_GROUP_ORDER = `total_amount DESC, campaign COLLATE "C", source COLLATE "C", medium COLLATE "C"`;

const donationAdminController = {
  getDashboardStats: async (req, res) => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

      const baseMatch = { ...DONATIONS_PAGE_FILTER, status: { $in: SUCCESS_STATUSES } };
      const needsAttentionFilter = {
        $and: [DONATIONS_PAGE_FILTER, { status: "completed" }, { $or: NEEDS_ATTENTION_OR }],
      };

      const [total, lastMonthTotal, thisMonthTotal, todayTotal, donorEmails, needsAttentionCount] = await Promise.all([
        sumCount(baseMatch),
        sumTotal({ ...baseMatch, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
        sumTotal({ ...baseMatch, createdAt: { $gte: startOfMonth } }),
        sumTotal({ ...baseMatch, createdAt: { $gte: startOfToday } }),
        // distinct donor emails (empty string is falsy and was filtered out before)
        countGroups({ ...baseMatch, donorEmail: { $nin: [null, ""] } }, "donor_email"),
        donations.count(needsAttentionFilter),
      ]);

      const pctChange = (curr, prev) => {
        if (!prev) return null;
        return Number((((curr - prev) / prev) * 100).toFixed(1));
      };

      res.status(200).json({
        success: true,
        stats: {
          totalDonations: { value: total.total, count: total.count },
          totalDonors: { value: donorEmails },
          thisMonth: { value: thisMonthTotal, changePct: pctChange(thisMonthTotal, lastMonthTotal) },
          today: { value: todayTotal },
          needsAttentionCount,
        },
      });
    } catch (error) {
      console.error("donationAdmin.getDashboardStats error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch dashboard stats" });
    }
  },

  getReport: async (req, res) => {
    try {
      const { startDate, endDate, sourcePage } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "startDate and endDate are required (YYYY-MM-DD)." });
      }
      const start = istDayStart(startDate);
      const end = istDayEnd(endDate);
      if (!start || !end) {
        return res
          .status(400)
          .json({ success: false, message: "startDate and endDate must be valid dates (YYYY-MM-DD)." });
      }

      const baseMatch = sourcePage
        ? { sourcePage, status: "completed", createdAt: { $gte: clampDate(start), $lte: clampDate(end) } }
        : { ...DONATIONS_PAGE_FILTER, status: "completed", createdAt: { $gte: clampDate(start), $lte: clampDate(end) } };

      const [summary, byPageAgg, dailyAgg, sevaAgg] = await Promise.all([
        sumCount(baseMatch),
        aggregate(baseMatch, "COALESCE(source_page, 'unknown') AS k, SUM(amount) AS amount, COUNT(*) AS count", {
          groupBy: "k",
          orderBy: `amount DESC, k COLLATE "C"`,
        }),
        aggregate(baseMatch, `${istDay("created_at")} AS k, SUM(amount) AS amount, COUNT(*) AS count`, {
          groupBy: "k",
          orderBy: "k",
        }),
        aggregate(baseMatch, `${SEVA_OR_TYPE_GENERAL} AS k, SUM(amount) AS amount, COUNT(*) AS count`, {
          groupBy: "k",
          orderBy: `amount DESC, k COLLATE "C"`,
          limit: 30,
        }),
      ]);

      res.status(200).json({
        success: true,
        range: { start, end },
        summary: { totalAmount: summary.total, count: summary.count },
        byPage: byPageAgg.map((p) => ({ sourcePage: p.k, amount: p.amount, count: p.count })),
        daily: dailyAgg.map((d) => ({ date: d.k, amount: d.amount, count: d.count })),
        sevaBreakdown: sevaAgg.map((s) => ({ name: s.k, amount: s.amount, count: s.count })),
      });
    } catch (error) {
      console.error("donationAdmin.getReport error:", error);
      res.status(500).json({ success: false, message: "Failed to generate report" });
    }
  },

  getAllTransactions: async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        search = "",
        status = "all",
        startDate,
        endDate,
        campaign,
        source,
        medium,
        sourcePage,
      } = req.query;

      // sourcePage narrows within the /donations family to one page.
      const and = [sourcePage ? { sourcePage } : DONATIONS_PAGE_FILTER];

      if (status === "needs_attention") {
        and.push({ status: "completed" }, { $or: NEEDS_ATTENTION_OR });
      } else if (status !== "all") {
        const statuses = String(status)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        and.push({ status: statuses.length === 1 ? statuses[0] : { $in: statuses } });
      }

      // Quirk kept from the Mongo build: sourcePage + search without needs_attention built an invalid $or and failed.
      if (search && sourcePage && status !== "needs_attention") throw new Error("Invalid query: $or must be an array");

      if (search) {
        and.push({
          $or: [
            { donorName: { $regex: search, $options: "i" } },
            { donorEmail: { $regex: search, $options: "i" } },
            { donorMobile: { $regex: search, $options: "i" } },
            { razorpayPaymentId: { $regex: search, $options: "i" } },
          ],
        });
      }

      const query = withUtmFilters(
        { $and: and, ...buildDateRangeMatch(startDate, endDate) },
        { campaign, source, medium }
      );

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      const castedQuery = castFilter(query);
      const [transactions, totalCount, totalAmount] = await Promise.all([
        donations.find(castedQuery, { sort: BY_NEWEST, skip, limit: limitNum, lean: true }),
        donations.count(castedQuery),
        sumTotal(query),
      ]);

      res.status(200).json({
        success: true,
        transactions: transactions.map((txn) => ({
          _id: txn._id.toString(),
          id: txn.razorpayPaymentId || `TXN${txn._id.toString().slice(-6).toUpperCase()}`,
          donorName: txn.donorName,
          donorEmail: txn.donorEmail,
          donorMobile: txn.donorMobile,
          amount: txn.amount,
          date: txn.createdAt,
          status: txn.status,
          sevaName: txn.sevaName || txn.type,
          message: txn.message,
          panNumber: txn.panNumber,
          certificate: txn.certificate,
          wantPrasadam: txn.wantPrasadam,
          prasadamAddress: txn.prasadamAddress,
          prasadamStatus: txn.prasadamStatus,
          prasadamCourier: txn.prasadamCourier,
          prasadamTrackingNumber: txn.prasadamTrackingNumber,
          prasadamDispatchedAt: txn.prasadamDispatchedAt,
          prasadamDeliveredAt: txn.prasadamDeliveredAt,
          receiptNumber: txn.receiptNumber,
          dccSyncStatus: txn.dccSyncStatus,
          razorpayPaymentId: txn.razorpayPaymentId,
          razorpayOrderId: txn.razorpayOrderId,
          utm: txn.utm,
          whatsappReceiptSentAt: txn.whatsappReceiptSentAt,
          whatsappReceiptError: txn.whatsappReceiptError,
        })),
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(totalCount / limitNum),
          totalTransactions: totalCount,
          totalAmount,
          limit: limitNum,
        },
      });
    } catch (error) {
      console.error("donationAdmin.getAllTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch transactions" });
    }
  },

  getTransactionById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
        return res.status(400).json({ success: false, message: "Invalid transaction ID" });
      }
      const txn = await donations.findOne({ _id: castId(id), ...DONATIONS_PAGE_FILTER }, { lean: true });
      if (!txn) return res.status(404).json({ success: false, message: "Transaction not found" });
      res.status(200).json({ success: true, transaction: txn });
    } catch (error) {
      console.error("donationAdmin.getTransactionById error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch transaction" });
    }
  },

  dccStatus: async (req, res) => {
    try {
      const status = await dccReceiptStatus({
        includeOld: req.query.includeOld === "true",
        scope: DONATIONS_PAGE_FILTER,
      });
      res.status(200).json({ success: true, configured: isDccConfigured(), running: isSweepRunning(), ...status });
    } catch (error) {
      console.error("donationAdmin.dccStatus error:", error);
      res.status(500).json({ success: false, message: "Failed to load DCC status" });
    }
  },

  dccPushAll: async (req, res) => {
    try {
      if (!isDccConfigured())
        return res.status(400).json({ success: false, message: "DCC is not configured on this server." });
      if (isSweepRunning()) return res.status(202).json({ success: true, message: "A push is already running." });
      sweepDccReceipts({ limit: 200, ignoreBackoff: true, scope: DONATIONS_PAGE_FILTER })
        .then((s) =>
          console.log(
            `[dcc-sweep] /donations admin push: pushed ${s.pushed}, ${s.receipts} receipt(s), ${s.whatsappSent} WhatsApp sent, ${s.failed} failing`
          )
        )
        .catch((e) => console.error("[dcc-sweep] /donations admin push failed:", e && e.message ? e.message : e));
      res.status(202).json({ success: true, message: "Pushing to DCC now." });
    } catch (error) {
      console.error("donationAdmin.dccPushAll error:", error);
      res.status(500).json({ success: false, message: "Could not start the push" });
    }
  },

  dccPushOne: async (req, res) => {
    try {
      const { id } = req.params;
      if (!id || !id.match(/^[0-9a-fA-F]{24}$/))
        return res.status(400).json({ success: false, message: "Invalid transaction ID" });
      const txn = await donations.findOne({ _id: castId(id), ...DONATIONS_PAGE_FILTER }, { fields: ["status"], lean: true });
      if (!txn) return res.status(404).json({ success: false, message: "Transaction not found" });
      if (txn.status !== "completed")
        return res.status(400).json({ success: false, message: "Only successful donations get a DCC receipt." });

      if (!isDccConfigured())
        return res.status(400).json({ success: false, message: "DCC is not configured on this server." });

      const result = await pushAndSendReceipt(castId(id));
      const message = pushResultMessage(result);
      res.status(result.receiptNumber ? 200 : 502).json({
        success: !!result.receiptNumber,
        message,
        receiptNumber: result.receiptNumber,
        whatsapp: result.whatsapp,
      });
    } catch (error) {
      console.error("donationAdmin.dccPushOne error:", error);
      res.status(500).json({ success: false, message: "Push to DCC failed" });
    }
  },

  setReceiptNumber: async (req, res) => {
    try {
      const { id } = req.params;
      const clean = String((req.body && req.body.receiptNumber) || "").trim();
      if (!id || !id.match(/^[0-9a-fA-F]{24}$/))
        return res.status(400).json({ success: false, message: "Invalid transaction ID" });
      if (!clean) return res.status(400).json({ success: false, message: "receiptNumber is required." });
      const txn = await donations.findOne({ _id: castId(id), ...DONATIONS_PAGE_FILTER }, { fields: ["_id"], lean: true });
      if (!txn) return res.status(404).json({ success: false, message: "Transaction not found" });

      const result = await setReceiptNumberAndSend(castId(id), clean);
      res.status(200).json({ success: true, message: result.message, whatsapp: result.whatsapp });
    } catch (error) {
      console.error("donationAdmin.setReceiptNumber error:", error);
      res.status(500).json({ success: false, message: "Could not save the receipt number" });
    }
  },

  getUtmStats: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const rows = await aggregate(
        { ...DONATIONS_PAGE_FILTER, status: { $in: SUCCESS_STATUSES }, ...buildDateRangeMatch(startDate, endDate) },
        UTM_GROUP_SELECT,
        { groupBy: "campaign, source, medium", orderBy: UTM_GROUP_ORDER }
      );
      res.status(200).json({ success: true, stats: utmGroupRows(rows) });
    } catch (error) {
      console.error("donationAdmin.getUtmStats error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM stats" });
    }
  },

  getUtmTransactions: async (req, res) => {
    try {
      const { campaign, source, medium, startDate, endDate } = req.query;
      const match = withUtmFilters(
        { ...DONATIONS_PAGE_FILTER, status: { $in: SUCCESS_STATUSES }, ...buildDateRangeMatch(startDate, endDate) },
        { campaign, source, medium }
      );

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
          "utm",
          "receiptNumber",
          "razorpayPaymentId",
        ],
      });

      res.status(200).json({ success: true, count: transactions.length, transactions });
    } catch (error) {
      console.error("donationAdmin.getUtmTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM transactions" });
    }
  },

  exportTransactions: async (req, res) => {
    try {
      const { startDate, endDate, status = "all" } = req.query;
      const query = { ...DONATIONS_PAGE_FILTER };

      if (status !== "all") {
        const statuses = String(status)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        query.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
      }
      Object.assign(query, buildDateRangeMatch(startDate, endDate));

      const transactions = await donations.find(castFilter(query), { sort: BY_NEWEST, lean: true });

      const headers = [
        "Transaction ID",
        "Donor Name",
        "Email",
        "Mobile",
        "Date",
        "Amount",
        "Status",
        "Seva",
        "Occasion / Note",
        "80G Certificate",
        "PAN Number",
        "Mahaprasadam Requested",
        "Prasadam Address",
        "Receipt Number",
        "DCC Sync Status",
        "WhatsApp Receipt Sent",
        "WhatsApp Error",
        "Campaign",
        "UTM Source",
        "UTM Medium",
        "UTM Content",
        "UTM Term",
        "Razorpay Order ID",
        "Razorpay Payment ID",
      ];

      const csvEscape = (val) => {
        const str = val === null || val === undefined ? "" : String(val);
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };

      const formatAddress = (addr) => {
        if (!addr) return "";
        return [addr.doorNo, addr.house, addr.street, addr.area, addr.city, addr.state, addr.pincode, addr.country]
          .filter(Boolean)
          .join(", ");
      };

      const rows = transactions.map((txn) => [
        txn.razorpayPaymentId || `TXN${txn._id.toString().slice(-6).toUpperCase()}`,
        txn.donorName || "",
        txn.donorEmail || "",
        txn.donorMobile || "",
        txn.createdAt ? new Date(txn.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
        txn.amount,
        txn.status,
        txn.sevaName || txn.type || "",
        txn.message || "",
        txn.certificate ? "Yes" : "No",
        txn.panNumber || "",
        txn.wantPrasadam ? "Yes" : "No",
        formatAddress(txn.prasadamAddress),
        txn.receiptNumber || "",
        txn.dccSyncStatus || "",
        txn.whatsappReceiptSentAt
          ? new Date(txn.whatsappReceiptSentAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
          : "",
        txn.whatsappReceiptError || "",
        txn.utm?.campaign || "",
        txn.utm?.source || "",
        txn.utm?.medium || "",
        txn.utm?.content || "",
        txn.utm?.term || "",
        txn.razorpayOrderId || "",
        txn.razorpayPaymentId || "",
      ]);

      const csv = [headers.join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="donations-transactions-${Date.now()}.csv"`);
      res.status(200).send(csv);
    } catch (error) {
      console.error("donationAdmin.exportTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to export transactions" });
    }
  },

  uploadImage: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const result = await uploadToR2(req.file.path, "donations-page");
      fs.unlink(req.file.path, () => {});
      res.status(200).json({ secure_url: result.secure_url });
    } catch (error) {
      console.error("donationAdmin.uploadImage error:", error);
      res.status(500).json({ message: error.message || "Image upload failed" });
    }
  },

  // Diagnostic: does Razorpay recognise this order id at all (vs wrong credentials/account)?
  diagnoseOrder: async (req, res) => {
    try {
      const { orderId, account } = req.query;
      const created = createRazorpayInstance(account || "donations");
      if (!created)
        return res
          .status(500)
          .json({ message: `No Razorpay credentials configured for account "${account || "donations"}"` });
      try {
        const order = await created.instance.orders.fetch(orderId);
        const payments = await created.instance.orders.fetchPayments(orderId);
        return res
          .status(200)
          .json({ keyIdPrefix: created.account.key_id?.slice(0, 8), order, payments: payments.items });
      } catch (err) {
        return res.status(200).json({
          keyIdPrefix: created.account.key_id?.slice(0, 8),
          orderFetchError: err.error || err.message || String(err),
        });
      }
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // Completes a donation with a payment id the admin confirmed in the Razorpay dashboard.
  manualComplete: async (req, res) => {
    try {
      const { donationId, razorpayPaymentId } = req.body;
      if (!donationId || !razorpayPaymentId) {
        return res.status(400).json({ message: "donationId and razorpayPaymentId are required." });
      }
      const donation = await donations.findById(castId(donationId));
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      if (donation.status === "completed") {
        return res.status(200).json({ message: "Already marked completed.", receiptNumber: donation.receiptNumber });
      }
      const completed = await completeDonation({ orderId: donation.razorpayOrderId, paymentId: razorpayPaymentId });
      res.status(200).json({
        message: `Marked completed using the payment ID you confirmed in the Razorpay dashboard. DCC/WhatsApp pipeline triggered.`,
        donation: completed,
      });
    } catch (error) {
      console.error("donationAdmin.manualComplete error:", error);
      res.status(500).json({ message: error.message || "Manual complete failed" });
    }
  },

  reconcilePending: async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));

      if (req.query.resetChecked === "true") {
        await donations.updateMany(
          { ...DONATIONS_PAGE_FILTER, status: "pending" },
          { $set: { lastReconcileCheckAt: null } }
        );
      }

      const pending = await donations.find(
        {
          ...DONATIONS_PAGE_FILTER,
          status: "pending",
          razorpayOrderId: { $ne: null },
          lastReconcileCheckAt: null,
        },
        {
          sort: { createdAt: 1, _id: 1 },
          limit,
          lean: true,
          fields: ["_id", "donorName", "amount", "razorpayOrderId", "paymentAccount", "createdAt"],
        }
      );

      const results = { total: pending.length, completed: [], stillPending: [], noRazorpayRecord: [], errors: [] };

      for (const donation of pending) {
        try {
          const created = createRazorpayInstance(donation.paymentAccount || "donations");
          if (!created) {
            results.errors.push({ id: donation._id, reason: "Razorpay not configured for this account" });
            continue;
          }

          const payments = await created.instance.orders.fetchPayments(donation.razorpayOrderId);
          const captured = (payments.items || []).find((p) => p.status === "captured");

          if (captured) {
            await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
            results.completed.push({
              id: donation._id,
              donorName: donation.donorName,
              amount: donation.amount,
              createdAt: donation.createdAt,
              razorpayPaymentId: captured.id,
            });
          } else if ((payments.items || []).length === 0) {
            await donations.updateById(donation._id, { lastReconcileCheckAt: new Date() });
            results.noRazorpayRecord.push({
              id: donation._id,
              donorName: donation.donorName,
              amount: donation.amount,
              createdAt: donation.createdAt,
            });
          } else {
            await donations.updateById(donation._id, { lastReconcileCheckAt: new Date() });
            results.stillPending.push({
              id: donation._id,
              donorName: donation.donorName,
              amount: donation.amount,
              createdAt: donation.createdAt,
              statuses: payments.items.map((p) => p.status),
            });
          }
        } catch (err) {
          results.errors.push({ id: donation._id, reason: err.message });
        }
        await new Promise((resolve) => setTimeout(resolve, 150)); // stay within Razorpay's rate limits
      }

      res.status(200).json({
        success: true,
        summary: {
          totalChecked: results.total,
          completedCount: results.completed.length,
          completedAmount: results.completed.reduce((s, d) => s + (d.amount || 0), 0),
          genuinelyAbandoned: results.noRazorpayRecord.length,
          stillPendingWithAttempt: results.stillPending.length,
          errors: results.errors.length,
        },
        results,
      });
    } catch (error) {
      console.error("donationAdmin.reconcilePending error:", error);
      res.status(500).json({ success: false, message: error.message || "Reconcile failed" });
    }
  },

  listPrasadamRequests: async (req, res) => {
    try {
      const out = await prasadamService.listRequests({
        scope: DONATIONS_PAGE_FILTER,
        dateMatch: buildDateRangeMatch(req.query.from, req.query.to),
        query: req.query,
      });
      res.status(200).json(out);
    } catch (error) {
      console.error("donationAdmin.listPrasadamRequests error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch prasadam requests" });
    }
  },

  updatePrasadamStatus: async (req, res) => {
    try {
      const { id } = req.params;
      if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
        return res.status(400).json({ success: false, message: "Invalid transaction ID" });
      }
      const status = req.body && req.body.prasadamStatus;
      if (!prasadamService.PRASADAM_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "prasadamStatus must be one of: pending, dispatched, delivered, cancelled",
        });
      }

      const donation = await donations.findOne({ _id: castId(id), ...DONATIONS_PAGE_FILTER });
      if (!donation) return res.status(404).json({ success: false, message: "Transaction not found" });
      if (!donation.wantPrasadam) {
        return res
          .status(400)
          .json({ success: false, message: "This donation has no Maha Prasadam request to track." });
      }
      if (donation.status !== "completed") {
        return res.status(400).json({ success: false, message: "Prasadam is only sent for completed donations." });
      }

      const next = prasadamService.applyStatusUpdate(donation, req.body);
      // Mongoose save() validated the required paths and wrote only what changed.
      if (!donation.donorName || donation.amount == null) throw new Error("donation validation failed");
      const same = (a, b) => (a ?? null) === (b ?? null) || (a instanceof Date && b instanceof Date && +a === +b);
      const patch = {};
      const unset = [];
      for (const k of PRASADAM_TRACKED) {
        if (next[k] === undefined) {
          if (donation[k] != null) unset.push(k);
        } else if (!same(next[k], donation[k])) patch[k] = next[k];
      }
      let updated = donation;
      if (unset.length || Object.keys(patch).length) {
        const raw = await donations.findById(donation._id, { lean: true });
        updated = await donations.updateById(donation._id, {
          ...defaultsToPersist(raw, donation, ["utm", "prasadamAddress"]),
          ...patch,
          ...(unset.length ? { $unset: unset } : {}),
        });
      }
      res.status(200).json({ success: true, message: `Prasadam request marked ${status}`, donation: updated });
    } catch (error) {
      console.error("donationAdmin.updatePrasadamStatus error:", error);
      res.status(500).json({ success: false, message: "Failed to update prasadam status" });
    }
  },

  exportPrasadamCsv: async (req, res) => {
    try {
      const csv = await prasadamService.buildCsv({
        scope: DONATIONS_PAGE_FILTER,
        dateMatch: buildDateRangeMatch(req.query.from, req.query.to),
        query: req.query,
      });
      const stamp = new Date().toLocaleDateString("en-CA", { timeZone: IST });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="donations-prasadam-dispatch-${stamp}.csv"`);
      res.status(200).send(csv);
    } catch (error) {
      console.error("donationAdmin.exportPrasadamCsv error:", error);
      res.status(500).json({ success: false, message: "Failed to export prasadam CSV" });
    }
  },
};

export { donationAdminController };
