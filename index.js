import "./src/config/timezone.js";
import "./src/config/env.js";
import { app } from "./app.js";
import { connectDb } from "./src/db/pg.js";
import { startReconciliationJob } from "./src/jobs/reconcilePendingDonations.js";
import { startTrackingSyncJob } from "./src/jobs/trackingSync.js";
import { startDccSweepJob } from "./src/jobs/dccReceiptSweep.js";
import { ensureDefaultShopCategories } from "./src/services/shopBootstrap.service.js";
import { ensureDefaultFestivalDonations } from "./src/services/festivalDonationBootstrap.service.js";
import { ensureBlogDrafts } from "./src/services/blogDraftsBootstrap.service.js";
import { runPendingReminders } from "./src/services/pendingReminder.service.js";
const PORT = process.env.PORT || 8080;

const startServer = async () => {
  try {
    await connectDb();

    ensureDefaultShopCategories().catch((err) => {
      console.error("Shop category bootstrap failed (non-fatal):", err && err.message ? err.message : err);
    });

    ensureDefaultFestivalDonations().catch((err) => {
      console.error("Festival-donation bootstrap failed (non-fatal):", err && err.message ? err.message : err);
    });

    // One-time import of the October 2026 blog batch (src/seed/blog-drafts).
    // Recorded in bootstrap_runs after success, so it never re-runs.
    ensureBlogDrafts().catch((err) => {
      console.error("Blog drafts import failed (non-fatal):", err && err.message ? err.message : err);
    });

    app.listen(PORT, () => {
      console.log(`server connected on port ${PORT}`);
    });

    // Disable with RECONCILE_ENABLED=false (local/test runs must never settle donations).
    if (process.env.RECONCILE_ENABLED !== "false") startReconciliationJob();

    // Every successful donation gets pushed to DCC until it has a receipt
    // number; the WhatsApp receipt follows. Disable with DCC_SWEEP_ENABLED=false.
    startDccSweepJob();

    startTrackingSyncJob();

    if (process.env.PENDING_REMINDER_ENABLED !== "false") {
      // Every minute, so the 3-minute reminder goes at 3 minutes, not
      // whenever the next 10-minute pass happens to come round.
      const intervalMinutes = Number(process.env.PENDING_REMINDER_INTERVAL_MINUTES || 1);
      let running = false;
      const run = () => {
        if (running) return;
        running = true;
        runPendingReminders()
          .then((result) => {
            if (result && result.checked > 0) {
              console.log(
                `Pending reminders pass: ${result.checked} checked, ${result.sent} sent, ${result.failed} failed`
              );
            }
          })
          .catch((err) => {
            console.error("Pending reminders scheduler error:", err && err.stack ? err.stack : err);
          })
          .finally(() => {
            running = false;
          });
      };
      // First pass shortly after boot, then on the interval.
      setTimeout(run, 30 * 1000);
      setInterval(run, intervalMinutes * 60 * 1000);
      console.log(`Pending-transaction WhatsApp reminders scheduled every ${intervalMinutes} min`);
    }
  } catch (error) {
    console.log("server failed to start", error);
    process.exit(1);
  }
};

startServer();
