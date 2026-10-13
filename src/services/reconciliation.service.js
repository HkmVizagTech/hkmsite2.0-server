const { donationModel } = require("../models/donation.model");
const { createRazorpayInstance } = require("../controllers/payment.controller");
const { completeDonation } = require("./paymentCompletion.service");

// The standalone /donations page (and anything under /donations/...) has
// its own dedicated admin — same pattern as donation.controller.js's
// EXCLUDE_DONATIONS_PAGE. Matches "donations" exactly or "donations/<any>".
const DONATIONS_DOMAIN_PATTERN = /^donations(\/|$)/;
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $not: DONATIONS_DOMAIN_PATTERN } };

// No donation stays "pending": once a checkout is this old and nothing was
// paid, it is closed as failed. 30 minutes leaves room for slow UPI
// approvals and bank OTPs. A donor who pays afterwards (reminder link, UPI
// match, manual complete, a late Razorpay webhook) still gets it completed —
// every completion path accepts a failed donation.
const CLOSE_UNPAID_AFTER_MINUTES = Number(process.env.CLOSE_UNPAID_AFTER_MINUTES || 30);
// A monthly seva sign-up with no paid first charge after this long.
const CLOSE_UNAUTHORISED_SUBSCRIPTION_AFTER_HOURS = Number(process.env.CLOSE_UNAUTHORISED_SUBSCRIPTION_AFTER_HOURS || 24);

/** pending -> failed, marked as "never paid" (not a declined payment). */
async function closeAsNotPaid(donationId) {
  await donationModel.updateOne(
    { _id: donationId, status: "pending" },
    { status: "failed", closedAsNotPaidAt: new Date() }
  );
}

/**
 * Pending donations with no Razorpay order to check: monthly seva sign-ups
 * (they have a subscription instead) and records that never got an order.
 */
async function closeStalePendingWithoutOrder({ limit = 200, fix = false } = {}) {
  const summary = { checked: 0, completed: 0, closedNotPaid: 0, subscriptionsLeft: 0, errors: 0 };
  const cutoff = new Date(Date.now() - CLOSE_UNPAID_AFTER_MINUTES * 60 * 1000);
  const subCutoff = new Date(Date.now() - CLOSE_UNAUTHORISED_SUBSCRIPTION_AFTER_HOURS * 60 * 60 * 1000);
  const stale = await donationModel
    .find({ status: "pending", razorpayOrderId: { $in: [null, ""] }, createdAt: { $lte: cutoff } })
    .sort({ lastReconcileCheckAt: 1, createdAt: -1 })
    .limit(limit)
    .select("_id subscriptionId paymentAccount manualEntry utrNumber createdAt")
    .lean();

  for (const d of stale) {
    summary.checked++;
    try {
      if (fix) await donationModel.updateOne({ _id: d._id }, { lastReconcileCheckAt: new Date() });
      if (d.manualEntry && d.utrNumber) {
        // Entered by hand with the UTR as proof of payment, but its
        // completion never ran (the server stopped mid-way): finish it.
        if (fix) await completeDonation({ donationId: d._id });
        summary.completed++;
        continue;
      }
      if (d.subscriptionId) {
        if (new Date(d.createdAt) > subCutoff) {
          summary.subscriptionsLeft++;
          continue;
        }
        const created = createRazorpayInstance(d.paymentAccount || "default");
        if (!created) {
          summary.errors++;
          continue;
        }
        // A paid invoice means the first monthly charge went through and its
        // webhook was missed: complete with that payment. Otherwise the
        // sign-up was never paid; if a charge comes later, the
        // subscription.charged webhook still completes this record.
        const invoices = await created.instance.invoices.all({ subscription_id: d.subscriptionId });
        const paid = ((invoices && invoices.items) || []).find((inv) => inv.status === "paid" && inv.payment_id);
        if (paid) {
          if (fix) await completeDonation({ donationId: d._id, paymentId: paid.payment_id });
          summary.completed++;
          continue;
        }
      }
      if (fix) await closeAsNotPaid(d._id);
      summary.closedNotPaid++;
    } catch (err) {
      summary.errors++;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return summary;
}

/**
 * Checks donations (that have a Razorpay order) against Razorpay's real
 * payment records and, when fix=true, resolves them:
 *   - captured on Razorpay but not completed here -> completes it (DCC +
 *     WhatsApp via the normal pipeline) — this is the webhook-miss safety
 *     net: if a webhook delivery ever fails (server restart mid-delivery,
 *     Razorpay retry window exhausted, etc.), this catches it regardless.
 *     Covers records currently sitting as "pending" AND "failed" — a
 *     failed record can be wrong too, if the failure was recorded before
 *     a later successful retry captured on Razorpay's side.
 *   - all attempts failed on Razorpay -> marks/confirms it failed here.
 *   - no payment attempts at all -> left as-is (genuinely abandoned checkout).
 *
 * `statuses` controls which starting statuses are checked — defaults to
 * just "pending" (existing behavior, used by the scheduled job). Pass
 * ["pending", "failed"] for a thorough sweep that also re-verifies
 * records already marked failed, in case any were wrong.
 *
 * Used by both GET /donations/audit-pending (manual, on-demand) and the
 * scheduled job in jobs/reconcilePendingDonations.js (automatic, periodic).
 */
async function reconcilePendingDonations({ limit = 100, skip = 0, fix = false, scope = "all", statuses = ["pending"], olderThanMinutes = 0 } = {}) {
  const baseFilter = {
    status: { $in: statuses },
    razorpayOrderId: { $exists: true, $ne: null },
  };
  if (olderThanMinutes > 0) baseFilter.createdAt = { $lte: new Date(Date.now() - olderThanMinutes * 60 * 1000) };
  if (scope === "donations-only") {
    baseFilter.sourcePage = DONATIONS_DOMAIN_PATTERN;
  } else if (scope !== "all") {
    Object.assign(baseFilter, EXCLUDE_DONATIONS_PAGE);
  }

  // Least recently checked first (never-checked before all), newest first
  // among those. Oldest-first used to re-check the same oldest records on
  // every run whenever they stayed pending, so newer ones were never reached.
  const pending = await donationModel
    .find(baseFilter)
    .sort({ lastReconcileCheckAt: 1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const results = [];
  const summary = {
    totalChecked: 0,
    capturedAndCompleted: 0,
    capturedWithReceipt: 0,
    markedFailed: 0,
    confirmedFailed: 0,
    closedNotPaid: 0,
    abandoned: 0,
    genuinelyPending: 0,
    errors: 0,
  };

  for (const donation of pending) {
    summary.totalChecked++;
    const wasAlreadyFailed = donation.status === "failed";
    const entry = {
      _id: donation._id.toString(),
      donorName: donation.donorName,
      amount: donation.amount,
      previousStatus: donation.status,
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
      if (fix) await donationModel.updateOne({ _id: donation._id }, { lastReconcileCheckAt: new Date() });
      const items = payments.items || [];
      const captured = items.find((p) => p.status === "captured");
      const authorized = items.some((p) => p.status === "authorized");
      const failedPayments = items.filter((p) => p.status === "failed");
      // A checkout older than CLOSE_UNPAID_AFTER_MINUTES with nothing paid is
      // over: the donor left. It is closed as failed ("not paid") so no
      // donation sits in pending; paying later still completes it.
      const closable = Date.now() - new Date(donation.createdAt).getTime() >= CLOSE_UNPAID_AFTER_MINUTES * 60 * 1000;

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
            entry.action = wasAlreadyFailed
              ? "CORRECTED (was marked failed, actually captured — status only, receipt already existed)"
              : "COMPLETED (status only — receipt already existed)";
            summary.capturedWithReceipt++;
          } else {
            await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
            entry.action = wasAlreadyFailed
              ? "CORRECTED (was marked failed, actually captured — full pipeline, DCC + WhatsApp triggered)"
              : "COMPLETED (full pipeline — DCC + WhatsApp triggered)";
            summary.capturedAndCompleted++;
          }
        } else {
          entry.action = wasAlreadyFailed ? "WOULD_CORRECT (marked failed but actually captured)" : "WOULD_COMPLETE";
          donation.receiptNumber ? summary.capturedWithReceipt++ : summary.capturedAndCompleted++;
        }
      } else if (authorized) {
        // The donor's money is authorised but was never captured (Razorpay
        // refunds it after a few days if nobody does). The donor meant to
        // pay, so capture it and complete the donation.
        const auth = items.find((p) => p.status === "authorized");
        entry.razorpayStatus = items.map((p) => p.status).join(", ");
        entry.razorpayPaymentId = auth.id;
        if (!fix) {
          entry.action = "WOULD_CAPTURE_AND_COMPLETE";
          summary.capturedAndCompleted++;
        } else {
          try {
            await created.instance.payments.capture(auth.id, auth.amount, auth.currency || "INR");
            await completeDonation({ orderId: donation.razorpayOrderId, paymentId: auth.id });
            entry.action = "CAPTURED_AND_COMPLETED (was authorized, not captured)";
            summary.capturedAndCompleted++;
          } catch (capErr) {
            const code = capErr && (capErr.statusCode || (capErr.error && capErr.error.code));
            if (code === 400 || code === "BAD_REQUEST_ERROR") {
              // Razorpay refuses: already refunded / expired. Nothing was paid.
              await donationModel.updateOne(
                { _id: donation._id, status: "pending" },
                {
                  status: "failed",
                  razorpayPaymentId: auth.id,
                  paymentError: {
                    paymentId: auth.id,
                    description: `Could not capture the authorised payment: ${(capErr.error && capErr.error.description) || capErr.message || "refused by Razorpay"}`,
                    method: auth.method || undefined,
                    at: new Date(),
                  },
                }
              );
              entry.action = "MARKED_FAILED (authorized payment could not be captured)";
              summary.markedFailed++;
            } else {
              // Network / Razorpay outage: try again on the next run.
              entry.error = (capErr && capErr.message) || String(capErr);
              entry.action = "ERROR (capture will be retried)";
              summary.errors++;
            }
          }
        }
      } else if (failedPayments.length === 0) {
        // No attempt at all, or only attempts the donor never finished
        // ("created").
        entry.razorpayStatus = items.length ? items.map((p) => p.status).join(", ") : "no_payments";
        if (wasAlreadyFailed) {
          entry.action = "CONFIRMED_FAILED (no successful payment)";
          summary.confirmedFailed++;
        } else if (!closable) {
          entry.action = "ABANDONED (too recent to close)";
          summary.abandoned++;
        } else if (fix) {
          await closeAsNotPaid(donation._id);
          entry.action = "CLOSED_NOT_PAID";
          summary.closedNotPaid++;
        } else {
          entry.action = "WOULD_CLOSE_NOT_PAID";
          summary.closedNotPaid++;
        }
      } else if (failedPayments.length === items.length || closable) {
        // Every attempt failed — or some failed and the rest were never
        // finished, and the checkout is old enough to be over.
        entry.razorpayStatus = "all_failed";
        if (wasAlreadyFailed) {
          entry.action = "CONFIRMED_FAILED (already correct)";
          summary.confirmedFailed++;
        } else if (fix) {
          await donationModel.findByIdAndUpdate(donation._id, {
            status: "failed",
            razorpayPaymentId: failedPayments[0].id,
          });
          // keep Razorpay's reason (the most recent failed attempt)
          const latest = failedPayments.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
          await require("./paymentFailure.service").recordPaymentFailure(donation._id, latest).catch(() => {});
          entry.action = "MARKED_FAILED";
          summary.markedFailed++;
        } else {
          entry.action = "WOULD_MARK_FAILED";
          summary.markedFailed++;
        }
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

module.exports = { reconcilePendingDonations, closeStalePendingWithoutOrder, CLOSE_UNPAID_AFTER_MINUTES };
