// GET /donations/payment-failures?days=7 — admin: why website payments fail.

import { donations, paymentDowntimes } from "../db/tables.js";
import { aggregate } from "../domain/donationQuery.js";

const paymentFailuresController = {
  summary: async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Website checkouts in the window (a Razorpay order was created).
      const checkouts = { createdAt: { $gte: since }, razorpayOrderId: { $ne: null } };
      const statusCounts = await aggregate(checkouts, "status AS k, COUNT(*) AS n", { groupBy: "k", orderBy: "k" });
      const totals = Object.fromEntries(statusCounts.map((s) => [s.k, s.n]));
      const started = statusCounts.reduce((a, s) => a + s.n, 0);
      // Closed as failed because nothing was ever paid (the donor left) vs declined payments.
      const notPaid = await donations.count({ ...checkouts, status: "failed", closedAsNotPaidAt: { $ne: null } });

      const withError = { "paymentError.at": { $gte: since } };

      const reasons = await aggregate(
        withError,
        `pe_description AS description, pe_reason AS reason, pe_source AS source,
         COUNT(*) AS donations,
         SUM(COALESCE(failed_attempts, 1)) AS attempts,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS paid_later,
         MIN(id) AS first_id`,
        {
          groupBy: "pe_description, pe_reason, pe_source",
          orderBy: "donations DESC, first_id",
          limit: 15,
        }
      );

      const byMethod = await aggregate(
        withError,
        "pe_method AS method, COALESCE(pe_bank, pe_wallet, pe_upi_flow, pe_card_network) AS via, COUNT(*) AS donations, MIN(id) AS first_id",
        {
          groupBy: "pe_method, COALESCE(pe_bank, pe_wallet, pe_upi_flow, pe_card_network)",
          orderBy: "donations DESC, first_id",
          limit: 15,
        }
      );

      const recent = await donations.find(withError, {
        sort: { "paymentError.at": -1, _id: 1 },
        limit: 60,
        lean: true,
        fields: [
          "donorName",
          "donorMobile",
          "amount",
          "sevaName",
          "sourcePage",
          "status",
          "createdAt",
          "failedAttempts",
          "paymentError",
          "razorpayOrderId",
          "upiFallback.status",
        ],
      });

      const downtimes = await paymentDowntimes.find(
        { receivedAt: { $gte: since }, event: "started" },
        { sort: { receivedAt: -1, _id: 1 }, limit: 200, lean: true }
      );
      const downtimeGroups = {};
      for (const d of downtimes) {
        const what =
          Object.values(d.instrument || {})
            .filter(Boolean)
            .join("/") || "all";
        const k = `${d.method || "?"} · ${what}`;
        downtimeGroups[k] = (downtimeGroups[k] || 0) + 1;
      }

      res.json({
        days,
        since,
        checkouts: {
          started,
          completed: totals.completed || 0,
          failed: Math.max(0, (totals.failed || 0) - notPaid), // declined / errored
          notPaid, // left without paying (closed after 30 min)
          pending: totals.pending || 0, // still within the 30 minutes
        },
        reasons: reasons.map((r) => ({
          description: r.description ?? undefined,
          reason: r.reason ?? undefined,
          source: r.source ?? undefined,
          donations: r.donations,
          attempts: r.attempts,
          paidLater: r.paid_later,
        })),
        byMethod: byMethod.map((m) => ({ method: m.method || "unknown", via: m.via || "—", donations: m.donations })),
        recent,
        downtime: {
          alerts: downtimes.length,
          top: Object.entries(downtimeGroups)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([what, n]) => ({ what, n })),
          latest: downtimes.slice(0, 15).map((d) => ({
            method: d.method,
            instrument: d.instrument,
            severity: d.severity,
            begin: d.begin,
            receivedAt: d.receivedAt,
          })),
        },
      });
    } catch (err) {
      console.error("paymentFailures.summary error:", err && err.message ? err.message : err);
      res.status(500).json({ message: "Could not load payment failures." });
    }
  },
};

export { paymentFailuresController };
