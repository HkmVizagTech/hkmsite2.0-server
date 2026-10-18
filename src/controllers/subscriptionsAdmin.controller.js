// GET /donations/subscriptions?search=&page=&limit= — Admin → Donations →
// Monthly Seva. One row per Razorpay subscription (monthly seva): the donor,
// what our records hold (months paid, total collected, last charge) and
// Razorpay's live state for the rows on screen (status, months charged, next
// charge). A row whose Razorpay charge count is ahead of ours has a missed
// month — POST /payments/backfill-subscription-gaps recovers those.

const { donationModel } = require("../models/donation.model");
const { IST } = require("../config/timezone");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Razorpay subscription states, in the words the screen uses.
const LIVE_LABEL = {
  created: "Not authorised yet",
  authenticated: "Authorised — first charge due",
  active: "Active",
  pending: "Charge failing — retrying",
  halted: "Halted (charges failed)",
  cancelled: "Cancelled",
  completed: "Completed",
  expired: "Expired",
  paused: "Paused",
};

function istMonthStart(now = new Date()) {
  const [y, m] = now.toLocaleDateString("en-CA", { timeZone: IST }).split("-").map(Number);
  return new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+05:30`);
}

const subscriptionsAdminController = {
  list: async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

      const base = { isRecurring: true, subscriptionId: { $nin: [null, ""] } };
      const match = { ...base };
      if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        match.$or = [{ donorName: re }, { donorMobile: re }, { donorEmail: re }, { subscriptionId: re }, { sevaName: re }];
      }

      const [result] = await donationModel.aggregate([
        { $match: match },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: "$subscriptionId",
            donorName: { $first: "$donorName" },
            donorMobile: { $first: "$donorMobile" },
            donorEmail: { $first: "$donorEmail" },
            sevaName: { $first: { $ifNull: ["$sevaName", "$type"] } },
            sourcePage: { $first: "$sourcePage" },
            paymentAccount: { $first: "$paymentAccount" },
            startedAt: { $first: "$createdAt" },
            signupStatus: { $first: "$status" },
            amount: { $last: "$amount" },
            monthsPaid: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            totalPaid: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$amount", 0] } },
            lastChargedAt: { $max: { $cond: [{ $eq: ["$status", "completed"] }, "$createdAt", null] } },
            missingReceipts: {
              $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $in: [{ $ifNull: ["$receiptNumber", ""] }, [""]] }] }, 1, 0] },
            },
          },
        },
        { $sort: { startedAt: -1 } },
        { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: "n" }] } },
      ]);
      const rows = result.rows || [];
      const total = (result.total[0] && result.total[0].n) || 0;

      // Razorpay's live state for this page only (one API call per row).
      const { createRazorpayInstance } = require("./payment.controller");
      await Promise.all(
        rows.map(async (r) => {
          r.subscriptionId = r._id;
          delete r._id;
          const created = createRazorpayInstance(r.paymentAccount);
          if (!created) return;
          try {
            const s = await created.instance.subscriptions.fetch(r.subscriptionId);
            r.live = {
              status: s.status,
              label: LIVE_LABEL[s.status] || s.status,
              paidCount: s.paid_count ?? null,
              remainingCount: s.remaining_count ?? null,
              nextChargeAt: s.charge_at ? new Date(s.charge_at * 1000) : null,
              endedAt: s.ended_at ? new Date(s.ended_at * 1000) : null,
            };
            // Razorpay charged more months than we recorded: a webhook was missed.
            r.missedMonths = typeof s.paid_count === "number" ? Math.max(0, s.paid_count - r.monthsPaid) : 0;
          } catch (e) {
            r.live = { error: (e && e.error && e.error.description) || (e && e.message) || "Razorpay unreachable" };
          }
        })
      );

      // Totals across every monthly seva (from our records).
      const monthStart = istMonthStart();
      const [totals] = await donationModel.aggregate([
        { $match: base },
        {
          $group: {
            _id: null,
            subscriptions: { $addToSet: "$subscriptionId" },
            chargesRecorded: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            collected: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$amount", 0] } },
            thisMonthCharges: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $gte: ["$createdAt", monthStart] }] }, 1, 0] } },
            thisMonthAmount: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $gte: ["$createdAt", monthStart] }] }, "$amount", 0] } },
          },
        },
        {
          $project: {
            _id: 0,
            subscriptions: { $size: "$subscriptions" },
            chargesRecorded: 1,
            collected: 1,
            thisMonthCharges: 1,
            thisMonthAmount: 1,
          },
        },
      ]);

      res.status(200).json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        summary: totals || { subscriptions: 0, chargesRecorded: 0, collected: 0, thisMonthCharges: 0, thisMonthAmount: 0 },
        subscriptions: rows.map(({ paymentAccount, ...r }) => ({ ...r, account: paymentAccount || "default" })),
      });
    } catch (err) {
      console.error("subscriptionsAdmin.list error:", err);
      res.status(500).json({ success: false, message: "Could not load monthly seva subscriptions." });
    }
  },
};

module.exports = { subscriptionsAdminController };
