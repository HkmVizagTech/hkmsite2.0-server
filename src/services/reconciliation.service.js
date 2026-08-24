const { donationModel } = require("../models/donation.model");
const { createRazorpayInstance } = require("../controllers/payment.controller");
const { completeDonation } = require("./paymentCompletion.service");

// The standalone /donations page has its own dedicated admin — same
// definition as donation.controller.js's EXCLUDE_DONATIONS_PAGE.
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $nin: ["donations", "donations/janmashtami2"] } };

/**
 * Checks pending donations (that have a Razorpay order) against Razorpay's
 * real payment records and, when fix=true, resolves them:
 *   - captured on Razorpay but still pending here -> completes it (DCC +
 *     WhatsApp via the normal pipeline) — this is the webhook-miss safety
 *     net: if a webhook delivery ever fails (server restart mid-delivery,
 *     Razorpay retry window exhausted, etc.), this catches it regardless.
 *   - all attempts failed on Razorpay -> marks it failed here too.
 *   - no payment attempts at all -> left as-is (genuinely abandoned checkout).
 *
 * Used by both GET /donations/audit-pending (manual, on-demand) and the
 * scheduled job in jobs/reconcilePendingDonations.js (automatic, periodic).
 */
async function reconcilePendingDonations({ limit = 100, fix = false, scope = "all" } = {}) {
  const baseFilter = {
    status: "pending",
    razorpayOrderId: { $exists: true, $ne: null },
  };
  if (scope !== "all") {
    Object.assign(baseFilter, EXCLUDE_DONATIONS_PAGE);
  }

  const pending = await donationModel
    .find(baseFilter)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

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
      amount: donation.amount,
      createdAt: donation.createdAt,
      razorpayOrderId: donation.razorpayOrderId,
      paymentAccount: donation.paymentAccount || "default",
      razorpayStatus: null,
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
      const captured = items.find((p) => p.status === "captured");
      const failedPayments = items.filter((p) => p.status === "failed");

      if (captured) {
        entry.razorpayStatus = "captured";
        entry.razorpayPaymentId = captured.id;
        if (fix) {
          if (donation.receiptNumber) {
            await donationModel.findByIdAndUpdate(donation._id, {
              status: "completed",
              razorpayPaymentId: captured.id,
              transactionId: captured.id,
            });
            entry.action = "COMPLETED (status only — receipt already existed)";
            summary.capturedWithReceipt++;
          } else {
            await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
            entry.action = "COMPLETED (full pipeline — DCC + WhatsApp triggered)";
            summary.capturedAndCompleted++;
          }
        } else {
          entry.action = "WOULD_COMPLETE";
          donation.receiptNumber ? summary.capturedWithReceipt++ : summary.capturedAndCompleted++;
        }
      } else if (items.length === 0) {
        entry.razorpayStatus = "no_payments";
        entry.action = "ABANDONED";
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
        entry.razorpayStatus = items.map((p) => p.status).join(", ");
        entry.action = "NEEDS_REVIEW";
        summary.genuinelyPending++;
      }
    } catch (err) {
      entry.error = err.message || String(err);
      entry.action = "ERROR";
      summary.errors++;
    }

    results.push(entry);
    // Stay well within Razorpay rate limits.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { summary, results };
}

module.exports = { reconcilePendingDonations };
