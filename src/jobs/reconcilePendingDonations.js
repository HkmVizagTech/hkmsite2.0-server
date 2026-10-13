const {
  reconcilePendingDonations,
  closeStalePendingWithoutOrder,
  CLOSE_UNPAID_AFTER_MINUTES,
} = require("../services/reconciliation.service");

// No donation stays "pending". Every run looks at donations pending for more
// than CLOSE_UNPAID_AFTER_MINUTES (30) and settles each one against
// Razorpay's own records:
//   - captured                      -> completed (DCC + WhatsApp as usual)
//   - every attempt failed          -> failed (Razorpay's reason kept)
//   - never paid / donor left       -> failed, marked closedAsNotPaidAt
//   - authorised, not yet captured  -> left; Razorpay settles it within minutes
// and closes monthly seva sign-ups never authorised within 24 h. It is also
// the safety net for missed webhooks (restart mid-delivery, Razorpay's retry
// window running out).
//
// Runs on a plain setInterval rather than a cron library — avoids adding
// a dependency for something this simple on an always-on Railway process.
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MINUTES || 15) * 60 * 1000;

let running = false;

async function runReconciliation() {
  if (running) return; // a big backlog can outlast one interval
  running = true;
  try {
    const { summary } = await reconcilePendingDonations({
      limit: 200,
      fix: true,
      scope: "all",
      olderThanMinutes: CLOSE_UNPAID_AFTER_MINUTES,
    });
    const noOrder = await closeStalePendingWithoutOrder({ limit: 200, fix: true });
    const fixed = summary.capturedAndCompleted + summary.capturedWithReceipt;
    if (fixed > 0 || summary.markedFailed > 0 || summary.closedNotPaid > 0 || noOrder.closedNotPaid > 0) {
      console.log(
        `[reconcile] completed ${fixed} paid, marked ${summary.markedFailed} failed, ` +
        `closed ${summary.closedNotPaid + noOrder.closedNotPaid} never paid ` +
        `(checked ${summary.totalChecked + noOrder.checked}, ${summary.genuinelyPending} awaiting capture, ` +
        `${summary.errors + noOrder.errors} errors)`
      );
    }
  } catch (err) {
    console.error("[reconcile] scheduled run failed:", err && err.message ? err.message : err);
  } finally {
    running = false;
  }
}

function startReconciliationJob() {
  // Run once shortly after boot (staggered, so it doesn't compete with
  // startup traffic), then on the regular interval.
  setTimeout(runReconciliation, 60 * 1000);
  setInterval(runReconciliation, INTERVAL_MS);
  console.log(`[reconcile] Scheduled donation reconciliation job started (every ${INTERVAL_MS / 60000} min).`);
}

module.exports = { startReconciliationJob, runReconciliation };
