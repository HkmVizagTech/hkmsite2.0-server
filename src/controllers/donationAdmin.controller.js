// src/controllers/donationAdmin.controller.js
//
// Analytics/admin API for the standalone /donations page specifically —
// scoped to donations where sourcePage === 'donations' (or legacy records
// with type: 'Donation'), separate from the main site's seva donations.
// Adapted from subhojanam-server's admin.controller.js (the proven
// annadan.harekrishnavizag.org admin dashboard pattern), trimmed to what
// this simpler one-time-donation page actually needs.

const fs = require("fs");
const { donationModel } = require("../models/donation.model");
const { uploadToR2 } = require("../utils/r2");
const { createRazorpayInstance } = require("./payment.controller");
const { completeDonation } = require("../services/paymentCompletion.service");

// Every query here is scoped to the /donations page's own donations only —
// never mixes in seva-page or campaign donations from the rest of the site.
const DONATIONS_PAGE_FILTER = {
  $or: [{ sourcePage: "donations" }, { sourcePage: "/donations" }, { type: "Donation" }],
};

const SUCCESS_STATUSES = ["completed"];

const donationAdminController = {
  // GET /donations-admin/dashboard-stats
  getDashboardStats: async (req, res) => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

      const baseMatch = { ...DONATIONS_PAGE_FILTER, status: { $in: SUCCESS_STATUSES } };

      const [totalAgg, lastMonthAgg, thisMonthAgg, todayAgg, donorEmails] = await Promise.all([
        donationModel.aggregate([
          { $match: baseMatch },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        donationModel.aggregate([
          { $match: { ...baseMatch, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        donationModel.aggregate([
          { $match: { ...baseMatch, createdAt: { $gte: startOfMonth } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        donationModel.aggregate([
          { $match: { ...baseMatch, createdAt: { $gte: startOfToday } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        donationModel.distinct("donorEmail", baseMatch),
      ]);

      const total = totalAgg[0]?.total || 0;
      const lastMonthTotal = lastMonthAgg[0]?.total || 0;
      const thisMonthTotal = thisMonthAgg[0]?.total || 0;
      const todayTotal = todayAgg[0]?.total || 0;

      const pctChange = (curr, prev) => {
        if (!prev) return null; // no prior-period baseline — don't fabricate a %
        return Number((((curr - prev) / prev) * 100).toFixed(1));
      };

      res.status(200).json({
        success: true,
        stats: {
          totalDonations: { value: total, count: totalAgg[0]?.count || 0 },
          totalDonors: { value: donorEmails.filter(Boolean).length },
          thisMonth: { value: thisMonthTotal, changePct: pctChange(thisMonthTotal, lastMonthTotal) },
          today: { value: todayTotal },
        },
      });
    } catch (error) {
      console.error("donationAdmin.getDashboardStats error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch dashboard stats" });
    }
  },

  // GET /donations-admin/transactions?page=&limit=&search=&status=&startDate=&endDate=&campaign=&source=&medium=
  getAllTransactions: async (req, res) => {
    try {
      const {
        page = 1, limit = 20, search = "", status = "all",
        startDate, endDate, campaign, source, medium,
      } = req.query;

      const query = { ...DONATIONS_PAGE_FILTER };

      if (status !== "all") {
        const statuses = String(status).split(",").map((s) => s.trim()).filter(Boolean);
        query.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
      }

      if (search) {
        query.$and = [
          { $or: query.$or }, // keep the page-scope filter
          {
            $or: [
              { donorName: { $regex: search, $options: "i" } },
              { donorEmail: { $regex: search, $options: "i" } },
              { donorMobile: { $regex: search, $options: "i" } },
              { razorpayPaymentId: { $regex: search, $options: "i" } },
            ],
          },
        ];
        delete query.$or; // superseded by $and above
      }

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          query.createdAt.$lte = end;
        }
      }

      if (campaign) query["utm.campaign"] = campaign === "direct" ? { $in: [null, ""] } : campaign;
      if (source) query["utm.source"] = source === "direct" ? { $in: [null, ""] } : source;
      if (medium) query["utm.medium"] = medium === "none" ? { $in: [null, ""] } : medium;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      const [transactions, totalCount, amountAgg] = await Promise.all([
        donationModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
        donationModel.countDocuments(query),
        donationModel.aggregate([{ $match: query }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
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
          totalAmount: amountAgg[0]?.total || 0,
          limit: limitNum,
        },
      });
    } catch (error) {
      console.error("donationAdmin.getAllTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch transactions" });
    }
  },

  // GET /donations-admin/transactions/:id
  getTransactionById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
        return res.status(400).json({ success: false, message: "Invalid transaction ID" });
      }
      const txn = await donationModel.findOne({ _id: id, ...DONATIONS_PAGE_FILTER }).lean();
      if (!txn) return res.status(404).json({ success: false, message: "Transaction not found" });
      res.status(200).json({ success: true, transaction: txn });
    } catch (error) {
      console.error("donationAdmin.getTransactionById error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch transaction" });
    }
  },

  // GET /donations-admin/utm-stats — aggregated campaign/source/medium metrics
  getUtmStats: async (req, res) => {
    try {
      const stats = await donationModel.aggregate([
        { $match: { ...DONATIONS_PAGE_FILTER, status: { $in: SUCCESS_STATUSES } } },
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
      res.status(200).json({ success: true, stats });
    } catch (error) {
      console.error("donationAdmin.getUtmStats error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM stats" });
    }
  },

  // GET /donations-admin/utm-transactions?campaign=&source=&medium= — the
  // "View" drill-down: real transaction list for one specific campaign row.
  getUtmTransactions: async (req, res) => {
    try {
      const { campaign, source, medium } = req.query;
      const match = { ...DONATIONS_PAGE_FILTER, status: { $in: SUCCESS_STATUSES } };
      if (campaign) match["utm.campaign"] = campaign === "direct" ? { $in: [null, ""] } : campaign;
      if (source) match["utm.source"] = source === "direct" ? { $in: [null, ""] } : source;
      if (medium) match["utm.medium"] = medium === "none" ? { $in: [null, ""] } : medium;

      const transactions = await donationModel
        .find(match)
        .sort({ createdAt: -1 })
        .limit(200)
        .select("donorName donorEmail donorMobile amount status createdAt utm receiptNumber razorpayPaymentId")
        .lean();

      res.status(200).json({ success: true, count: transactions.length, transactions });
    } catch (error) {
      console.error("donationAdmin.getUtmTransactions error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch UTM transactions" });
    }
  },
  // GET /donations-admin/export?startDate=&endDate=&status= — CSV download
  exportTransactions: async (req, res) => {
    try {
      const { startDate, endDate, status = "all" } = req.query;
      const query = { ...DONATIONS_PAGE_FILTER };

      if (status !== "all") {
        const statuses = String(status).split(",").map((s) => s.trim()).filter(Boolean);
        query.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
      }
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          query.createdAt.$lte = end;
        }
      }

      const transactions = await donationModel.find(query).sort({ createdAt: -1 }).lean();

      const headers = [
        "Transaction ID", "Donor Name", "Email", "Mobile", "Date", "Amount", "Status",
        "Seva", "80G Certificate", "PAN Number", "Receipt Number", "WhatsApp Receipt Sent",
        "Campaign", "UTM Source", "UTM Medium", "UTM Content", "Razorpay Order ID", "Razorpay Payment ID",
      ];

      const csvEscape = (val) => {
        const str = val === null || val === undefined ? "" : String(val);
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
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
        txn.certificate ? "Yes" : "No",
        txn.panNumber || "",
        txn.receiptNumber || "",
        txn.whatsappReceiptSentAt ? new Date(txn.whatsappReceiptSentAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
        txn.utm?.campaign || "",
        txn.utm?.source || "",
        txn.utm?.medium || "",
        txn.utm?.content || "",
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
  // POST /donations-admin/upload-image — for the Page Content tab's image
  // fields (hero banner, seva cards, etc). Uses R2 like the rest of the
  // site instead of the old client-side unsigned Cloudinary upload, which
  // depended on NEXT_PUBLIC_CLOUDINARY_* env vars that may not even be set.
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

  // POST /donations-admin/reconcile-pending — checks every pending
  // /donations-page transaction against Razorpay's real payment records
  // (never guesses) and properly completes any that were actually
  // captured, same pipeline as a normal successful checkout (DCC +
  // WhatsApp). Streams a small delay between Razorpay calls to stay well
  // within rate limits over what can be a large batch.
  // TEMPORARY diagnostic — checks whether Razorpay recognizes an order ID
  // at all (not just whether it has payments), to distinguish "genuinely
  // abandoned checkout" from "wrong Razorpay credentials/account mismatch".
  diagnoseOrder: async (req, res) => {
    try {
      const { orderId, account } = req.query;
      const created = createRazorpayInstance(account || "donations");
      if (!created) return res.status(500).json({ message: `No Razorpay credentials configured for account "${account || "donations"}"` });
      try {
        const order = await created.instance.orders.fetch(orderId);
        const payments = await created.instance.orders.fetchPayments(orderId);
        return res.status(200).json({ keyIdPrefix: created.account.key_id?.slice(0, 8), order, payments: payments.items });
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

  // POST /donations-admin/manual-complete — for donations from before an
  // API key rotation, where Razorpay's dashboard (login-based) still shows
  // the truth but our API can no longer look the order up with the new
  // keys. Admin manually confirms a real payment ID found in the
  // dashboard, and this runs it through the exact same completion
  // pipeline (DCC + WhatsApp) as a normal successful checkout — no
  // Razorpay API call needed, since the admin has already verified it.
  manualComplete: async (req, res) => {
    try {
      const { donationId, razorpayPaymentId } = req.body;
      if (!donationId || !razorpayPaymentId) {
        return res.status(400).json({ message: "donationId and razorpayPaymentId are required." });
      }
      const donation = await donationModel.findById(donationId);
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

      // When the Razorpay keys change again, everything marked "checked"
      // under the OLD keys needs a fresh look under the NEW ones --
      // resetChecked=true clears that marker for all still-pending
      // donations-page transactions before this batch runs.
      if (req.query.resetChecked === "true") {
        await donationModel.updateMany(
          { ...DONATIONS_PAGE_FILTER, status: "pending" },
          { $set: { lastReconcileCheckAt: null } }
        );
      }

      const pending = await donationModel
        .find({
          ...DONATIONS_PAGE_FILTER,
          status: "pending",
          razorpayOrderId: { $exists: true, $ne: null },
          lastReconcileCheckAt: null, // skip anything already checked and confirmed not-captured
        })
        .sort({ createdAt: 1 }) // oldest first — works through the backlog systematically
        .limit(limit)
        .select("_id donorName amount razorpayOrderId paymentAccount createdAt")
        .lean();

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
            results.completed.push({ id: donation._id, donorName: donation.donorName, amount: donation.amount, createdAt: donation.createdAt, razorpayPaymentId: captured.id });
          } else if ((payments.items || []).length === 0) {
            await donationModel.findByIdAndUpdate(donation._id, { lastReconcileCheckAt: new Date() });
            results.noRazorpayRecord.push({ id: donation._id, donorName: donation.donorName, amount: donation.amount, createdAt: donation.createdAt });
          } else {
            await donationModel.findByIdAndUpdate(donation._id, { lastReconcileCheckAt: new Date() });
            results.stillPending.push({ id: donation._id, donorName: donation.donorName, amount: donation.amount, createdAt: donation.createdAt, statuses: payments.items.map((p) => p.status) });
          }
        } catch (err) {
          results.errors.push({ id: donation._id, reason: err.message });
        }
        await new Promise((resolve) => setTimeout(resolve, 150)); // stay well within Razorpay's rate limits
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
};

module.exports = { donationAdminController };
