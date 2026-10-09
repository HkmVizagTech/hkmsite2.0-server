// GET /donations/payment-failures?days=7 — admin: why website payments fail.
// Built from the reasons Razorpay gives for each failed attempt
// (donation.paymentError, via services/paymentFailure.service.js) and the
// bank / UPI-app downtime alerts Razorpay sends.

const { donationModel } = require("../models/donation.model");
const { paymentDowntimeModel } = require("../services/paymentFailure.service");

const paymentFailuresController = {
  summary: async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Website checkouts in the window (a Razorpay order was created).
      const statusCounts = await donationModel.aggregate([
        { $match: { createdAt: { $gte: since }, razorpayOrderId: { $exists: true, $ne: null } } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]);
      const totals = Object.fromEntries(statusCounts.map((s) => [s._id, s.n]));
      const started = statusCounts.reduce((a, s) => a + s.n, 0);

      const withError = { "paymentError.at": { $gte: since } };

      const reasons = await donationModel.aggregate([
        { $match: withError },
        {
          $group: {
            _id: { description: "$paymentError.description", reason: "$paymentError.reason", source: "$paymentError.source" },
            donations: { $sum: 1 },
            attempts: { $sum: { $ifNull: ["$failedAttempts", 1] } },
            paidLater: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          },
        },
        { $sort: { donations: -1 } },
        { $limit: 15 },
      ]);

      const byMethod = await donationModel.aggregate([
        { $match: withError },
        {
          $group: {
            _id: {
              method: "$paymentError.method",
              via: { $ifNull: ["$paymentError.bank", { $ifNull: ["$paymentError.wallet", { $ifNull: ["$paymentError.upiFlow", "$paymentError.cardNetwork"] }] }] },
            },
            donations: { $sum: 1 },
          },
        },
        { $sort: { donations: -1 } },
        { $limit: 15 },
      ]);

      const recent = await donationModel
        .find(withError)
        .sort({ "paymentError.at": -1 })
        .limit(60)
        .select("donorName donorMobile amount sevaName sourcePage status createdAt failedAttempts paymentError razorpayOrderId upiFallback.status")
        .lean();

      const downtimes = await paymentDowntimeModel
        .find({ receivedAt: { $gte: since }, event: "started" })
        .sort({ receivedAt: -1 })
        .limit(200)
        .lean();
      const downtimeGroups = {};
      for (const d of downtimes) {
        const what = Object.values(d.instrument || {}).filter(Boolean).join("/") || "all";
        const k = `${d.method || "?"} · ${what}`;
        downtimeGroups[k] = (downtimeGroups[k] || 0) + 1;
      }

      res.json({
        days,
        since,
        checkouts: { started, completed: totals.completed || 0, failed: totals.failed || 0, pending: totals.pending || 0 },
        reasons: reasons.map((r) => ({ ...r._id, donations: r.donations, attempts: r.attempts, paidLater: r.paidLater })),
        byMethod: byMethod.map((m) => ({ method: m._id.method || "unknown", via: m._id.via || "—", donations: m.donations })),
        recent,
        downtime: {
          alerts: downtimes.length,
          top: Object.entries(downtimeGroups)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([what, n]) => ({ what, n })),
          latest: downtimes.slice(0, 15).map((d) => ({ method: d.method, instrument: d.instrument, severity: d.severity, begin: d.begin, receivedAt: d.receivedAt })),
        },
      });
    } catch (err) {
      console.error("paymentFailures.summary error:", err && err.message ? err.message : err);
      res.status(500).json({ message: "Could not load payment failures." });
    }
  },
};

module.exports = { paymentFailuresController };
