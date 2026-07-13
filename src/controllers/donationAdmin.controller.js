// src/controllers/donationAdmin.controller.js
//
// Analytics/admin API for the standalone /donations page specifically —
// scoped to donations where sourcePage === 'donations' (or legacy records
// with type: 'Donation'), separate from the main site's seva donations.
// Adapted from subhojanam-server's admin.controller.js (the proven
// annadan.harekrishnavizag.org admin dashboard pattern), trimmed to what
// this simpler one-time-donation page actually needs.

const { donationModel } = require("../models/donation.model");

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
          panNumber: txn.panNumber,
          certificate: txn.certificate,
          receiptNumber: txn.receiptNumber,
          razorpayPaymentId: txn.razorpayPaymentId,
          razorpayOrderId: txn.razorpayOrderId,
          utm: txn.utm,
          whatsappReceiptSentAt: txn.whatsappReceiptSentAt,
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
};

module.exports = { donationAdminController };
