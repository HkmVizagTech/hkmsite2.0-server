import { recordPaymentFailure } from "./paymentFailure.service.js";
import {
  donations,
  claimUpdate,
  selectDonations,
  wholePaymentError,
  DONATIONS_PAGE_SQL_REGEX,
} from "../domain/donationDb.js";
import { createRazorpayInstance } from "../controllers/payment.controller.js";
import { completeDonation } from "./paymentCompletion.service.js";
import { AUTO_SINCE } from "./dccSweep.service.js";

const whatsAppFor = (d) => new Date(d.createdAt) >= AUTO_SINCE;

const DONATIONS_DOMAIN_PATTERN = new RegExp(DONATIONS_PAGE_SQL_REGEX);
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $not: DONATIONS_DOMAIN_PATTERN } };

// Mongo sorts null/missing first ascending; Postgres sorts them last unless told otherwise.
const LEAST_RECENTLY_CHECKED_FIRST = "last_reconcile_check_at ASC NULLS FIRST, created_at DESC, id";

const CLOSE_UNPAID_AFTER_MINUTES = Number(process.env.CLOSE_UNPAID_AFTER_MINUTES || 30);
// A monthly seva sign-up with no paid first charge after this long.
const CLOSE_UNAUTHORISED_SUBSCRIPTION_AFTER_HOURS = Number(
  process.env.CLOSE_UNAUTHORISED_SUBSCRIPTION_AFTER_HOURS || 24
);

/** pending -> failed, marked as "never paid" (not a declined payment). */
async function closeAsNotPaid(donationId) {
  await claimUpdate(
    { _id: String(donationId), status: "pending" },
    { status: "failed", closedAsNotPaidAt: new Date() }
  );
}

async function closeStalePendingWithoutOrder({ limit = 200, fix = false } = {}) {
  const summary = { checked: 0, completed: 0, closedNotPaid: 0, subscriptionsLeft: 0, errors: 0 };
  const cutoff = new Date(Date.now() - CLOSE_UNPAID_AFTER_MINUTES * 60 * 1000);
  const subCutoff = new Date(Date.now() - CLOSE_UNAUTHORISED_SUBSCRIPTION_AFTER_HOURS * 60 * 60 * 1000);
  const stale = await selectDonations(
    { status: "pending", razorpayOrderId: { $in: [null, ""] }, createdAt: { $lte: cutoff } },
    { orderBy: LEAST_RECENTLY_CHECKED_FIRST, limit }
  );

  for (const d of stale) {
    summary.checked++;
    try {
      if (fix) await donations.updateById(d._id, { lastReconcileCheckAt: new Date() });
      if (d.manualEntry && d.utrNumber) {
        // Entered by hand with the UTR as proof of payment, but its
        // completion never ran (the server stopped mid-way): finish it.
        if (fix) await completeDonation({ donationId: d._id, sendWhatsApp: whatsAppFor(d) });
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
        const invoices = await created.instance.invoices.all({ subscription_id: d.subscriptionId });
        const paid = ((invoices && invoices.items) || []).find((inv) => inv.status === "paid" && inv.payment_id);
        if (paid) {
          if (fix)
            await completeDonation({ donationId: d._id, paymentId: paid.payment_id, sendWhatsApp: whatsAppFor(d) });
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

async function reconcilePendingDonations({
  limit = 100,
  skip = 0,
  fix = false,
  scope = "all",
  statuses = ["pending"],
  olderThanMinutes = 0,
} = {}) {
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

  const pending = await selectDonations(baseFilter, { orderBy: LEAST_RECENTLY_CHECKED_FIRST, skip, limit });

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
      if (fix) await donations.updateById(donation._id, { lastReconcileCheckAt: new Date() });
      const items = payments.items || [];
      const captured = items.find((p) => p.status === "captured");
      const authorized = items.some((p) => p.status === "authorized");
      const failedPayments = items.filter((p) => p.status === "failed");
      const closable = Date.now() - new Date(donation.createdAt).getTime() >= CLOSE_UNPAID_AFTER_MINUTES * 60 * 1000;

      if (captured) {
        entry.razorpayStatus = "captured";
        entry.razorpayPaymentId = captured.id;
        if (fix) {
          if (donation.receiptNumber) {
            await donations.updateById(donation._id, {
              status: "completed",
              razorpayPaymentId: captured.id,
              transactionId: captured.id,
            });
            entry.action = wasAlreadyFailed
              ? "CORRECTED (was marked failed, actually captured — status only, receipt already existed)"
              : "COMPLETED (status only — receipt already existed)";
            summary.capturedWithReceipt++;
          } else {
            await completeDonation({
              orderId: donation.razorpayOrderId,
              paymentId: captured.id,
              sendWhatsApp: whatsAppFor(donation),
            });
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
        const auth = items.find((p) => p.status === "authorized");
        entry.razorpayStatus = items.map((p) => p.status).join(", ");
        entry.razorpayPaymentId = auth.id;
        if (!fix) {
          entry.action = "WOULD_CAPTURE_AND_COMPLETE";
          summary.capturedAndCompleted++;
        } else {
          try {
            await created.instance.payments.capture(auth.id, auth.amount, auth.currency || "INR");
            await completeDonation({
              orderId: donation.razorpayOrderId,
              paymentId: auth.id,
              sendWhatsApp: whatsAppFor(donation),
            });
            entry.action = "CAPTURED_AND_COMPLETED (was authorized, not captured)";
            summary.capturedAndCompleted++;
          } catch (capErr) {
            const code = capErr && (capErr.statusCode || (capErr.error && capErr.error.code));
            if (code === 400 || code === "BAD_REQUEST_ERROR") {
              // Razorpay refuses: already refunded / expired. Nothing was paid.
              await claimUpdate(
                { _id: String(donation._id), status: "pending" },
                {
                  status: "failed",
                  razorpayPaymentId: auth.id,
                  paymentError: wholePaymentError({
                    paymentId: auth.id,
                    description: `Could not capture the authorised payment: ${(capErr.error && capErr.error.description) || capErr.message || "refused by Razorpay"}`,
                    method: auth.method || undefined,
                    at: new Date(),
                  }),
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
          await claimUpdate(
            { _id: String(donation._id), status: { $ne: "completed" } },
            {
              status: "failed",
              razorpayPaymentId: failedPayments[0].id,
            }
          );
          // keep Razorpay's reason (the most recent failed attempt)
          const latest = failedPayments.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
          await recordPaymentFailure(donation._id, latest).catch(() => {});
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

export { reconcilePendingDonations, closeStalePendingWithoutOrder, CLOSE_UNPAID_AFTER_MINUTES };
