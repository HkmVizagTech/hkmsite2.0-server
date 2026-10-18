// GET /donations/subscriptions — Admin → Donations → Monthly Seva.
// One row per Razorpay subscription (monthly seva): the donor, what our
// records hold (months paid, total collected, last charge) and Razorpay's live
// state (status, months charged, next charge). A row whose Razorpay charge
// count is ahead of ours has a missed month — POST
// /payments/backfill-subscription-gaps recovers those.
//
// Query: search, status (all | active | authorised | failing | notStarted |
// ended | unknown), seva, attention=1 (missed months or missing receipts),
// page, limit, fresh=1 (re-read Razorpay now instead of the 5-minute copy).
//
// Razorpay's status for EVERY subscription is needed to filter by status and
// to add up what active subscriptions are worth, so the whole list is read
// with subscriptions.all (100 per call) and kept for 5 minutes.

const { donationModel } = require("../models/donation.model");
const { IST } = require("../config/timezone");
const { cacheWrap, cacheDel } = require("../cache/memoryCache");

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

// Filter groups shown on the screen.
const BUCKET_OF = {
  active: "active",
  authenticated: "authorised",
  pending: "failing",
  halted: "failing",
  paused: "failing",
  created: "notStarted",
  cancelled: "ended",
  expired: "ended",
  completed: "ended",
};
const BUCKETS = ["active", "authorised", "failing", "notStarted", "ended", "unknown"];

function istMonthStart(now = new Date()) {
  const [y, m] = now.toLocaleDateString("en-CA", { timeZone: IST }).split("-").map(Number);
  return new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+05:30`);
}

/** subscriptionId -> Razorpay's live state, for one Razorpay account (5-minute copy). */
async function liveSubscriptions(account, fresh) {
  const key = `subs:live:${account}`;
  if (fresh) await cacheDel(key);
  return cacheWrap(key, 300, async () => {
    const { createRazorpayInstance } = require("./payment.controller");
    const created = createRazorpayInstance(account);
    if (!created) return null;
    const map = {};
    for (let skip = 0; skip < 10000; skip += 100) {
      const page = await created.instance.subscriptions.all({ count: 100, skip });
      const items = (page && page.items) || [];
      for (const s of items) {
        map[s.id] = {
          status: s.status,
          paidCount: s.paid_count ?? null,
          remainingCount: s.remaining_count ?? null,
          nextChargeAt: s.charge_at ? new Date(s.charge_at * 1000) : null,
          endedAt: s.ended_at ? new Date(s.ended_at * 1000) : null,
        };
      }
      if (items.length < 100) break;
    }
    return map;
  });
}

const subscriptionsAdminController = {
  list: async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const statusFilter = BUCKETS.includes(req.query.status) ? req.query.status : "all";
      const sevaFilter = typeof req.query.seva === "string" ? req.query.seva.trim() : "";
      const attentionOnly = req.query.attention === "1" || req.query.attention === "true";
      const fresh = req.query.fresh === "1" || req.query.fresh === "true";

      const base = { isRecurring: true, subscriptionId: { $nin: [null, ""] } };

      // Every subscription with our totals (a few hundred rows at most).
      const groups = await donationModel.aggregate([
        { $match: base },
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
      ]);

      // Razorpay's live state for every account these subscriptions use.
      const accounts = [...new Set(groups.map((g) => g.paymentAccount || "default"))];
      const live = {};
      const liveErrors = {};
      await Promise.all(
        accounts.map(async (acc) => {
          try {
            live[acc] = await liveSubscriptions(acc, fresh);
          } catch (e) {
            liveErrors[acc] = (e && e.error && e.error.description) || (e && e.message) || "Razorpay unreachable";
          }
        })
      );

      const rows = groups.map((g) => {
        const account = g.paymentAccount || "default";
        const l = live[account] && live[account][g._id];
        const row = {
          subscriptionId: g._id,
          donorName: g.donorName,
          donorMobile: g.donorMobile,
          donorEmail: g.donorEmail,
          sevaName: g.sevaName || "Monthly Seva",
          sourcePage: g.sourcePage,
          account,
          startedAt: g.startedAt,
          amount: g.amount,
          monthsPaid: g.monthsPaid,
          totalPaid: g.totalPaid,
          lastChargedAt: g.lastChargedAt,
          missingReceipts: g.missingReceipts,
          live: l
            ? { ...l, label: LIVE_LABEL[l.status] || l.status }
            : { error: liveErrors[account] || (live[account] === null ? "Razorpay not configured" : "Not found on Razorpay") },
          bucket: l ? BUCKET_OF[l.status] || "unknown" : "unknown",
          missedMonths: l && typeof l.paidCount === "number" ? Math.max(0, l.paidCount - g.monthsPaid) : 0,
        };
        row.needsAttention = row.missedMonths > 0 || row.missingReceipts > 0;
        return row;
      });

      // What active monthly seva is worth: active subscriptions charge every
      // month; authorised ones start charging at their first due date.
      const sumAmount = (list) => list.reduce((a, r) => a + (Number(r.amount) || 0), 0);
      const activeRows = rows.filter((r) => r.bucket === "active");
      const authorisedRows = rows.filter((r) => r.bucket === "authorised");
      const statusCounts = Object.fromEntries(BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]));

      // Filters
      let filtered = rows;
      if (statusFilter !== "all") filtered = filtered.filter((r) => r.bucket === statusFilter);
      if (sevaFilter) filtered = filtered.filter((r) => r.sevaName === sevaFilter);
      if (attentionOnly) filtered = filtered.filter((r) => r.needsAttention);
      if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        filtered = filtered.filter((r) => [r.donorName, r.donorMobile, r.donorEmail, r.subscriptionId, r.sevaName].some((v) => v && re.test(String(v))));
      }
      const total = filtered.length;
      const pageRows = filtered.slice((page - 1) * limit, page * limit);

      // Collected totals (our records).
      const monthStart = istMonthStart();
      const [totals] = await donationModel.aggregate([
        { $match: base },
        {
          $group: {
            _id: null,
            chargesRecorded: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            collected: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$amount", 0] } },
            thisMonthCharges: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $gte: ["$createdAt", monthStart] }] }, 1, 0] } },
            thisMonthAmount: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $gte: ["$createdAt", monthStart] }] }, "$amount", 0] } },
          },
        },
        { $project: { _id: 0 } },
      ]);

      res.status(200).json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        liveCheckedAt: new Date(),
        liveErrors,
        summary: {
          subscriptions: rows.length,
          activeCount: activeRows.length,
          activeMonthly: sumAmount(activeRows),
          authorisedCount: authorisedRows.length,
          authorisedMonthly: sumAmount(authorisedRows),
          needsAttention: rows.filter((r) => r.needsAttention).length,
          ...(totals || { chargesRecorded: 0, collected: 0, thisMonthCharges: 0, thisMonthAmount: 0 }),
        },
        statusCounts,
        sevaOptions: [...new Set(rows.map((r) => r.sevaName).filter(Boolean))].sort(),
        subscriptions: pageRows,
      });
    } catch (err) {
      console.error("subscriptionsAdmin.list error:", err);
      res.status(500).json({ success: false, message: "Could not load monthly seva subscriptions." });
    }
  },
};

module.exports = { subscriptionsAdminController };
