const { reconcilePendingDonations } = require("../services/reconciliation.service");

// Safety net for missed webhook deliveries. Even with the webhook itself
// working correctly, a delivery can still fail to land — a brief server
// restart during a deploy, a network blip, Razorpay's retry window
// (24h with backoff) getting exhausted at bad timing. This runs
// periodically in the background and quietly fixes anything the webhook
// missed, so a donor's payment never sits uncompleted for long even if a
// single delivery attempt failed.
//
// Runs on a plain setInterval rather than a cron library — avoids adding
// a dependency for something this simple on an always-on Railway process.
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MINUTES || 180) * 60 * 1000; // default: every 3 hours

async function runReconciliation() {
  try {
    const { summary } = await reconcilePendingDonations({ limit: 200, fix: true, scope: "all" });
    const fixed = summary.capturedAndCompleted + summary.capturedWithReceipt;
    if (fixed > 0 || summary.markedFailed > 0) {
      console.log(
        `[reconcile] Fixed ${fixed} missed capture(s), marked ${summary.markedFailed} failed ` +
        `(checked ${summary.totalChecked}, ${summary.abandoned} abandoned, ${summary.errors} errors)`
      );
    }
  } catch (err) {
    console.error("[reconcile] scheduled run failed:", err && err.message ? err.message : err);
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
