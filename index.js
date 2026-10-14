
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

const startServer =async()=>{
    try {
        await connectDb()

        // Seed default shop categories on boot so a fresh/empty DB ships
        // with a usable catalog. Errors are logged and swallowed — the
        // server still starts even if the seed hiccups.
        ensureDefaultShopCategories().catch((err) => {
            console.error("Shop category bootstrap failed (non-fatal):", err && err.message ? err.message : err);
        });

        // Seed the canonical festival-donation campaigns (Radhashtami,
        // Govardhan Puja, Ekadashi) and deactivate test/junk records so the
        // home/donations "Festival Donations" section always shows real
        // campaigns. Idempotent; errors are logged and swallowed.
        ensureDefaultFestivalDonations().catch((err) => {
            console.error("Festival-donation bootstrap failed (non-fatal):", err && err.message ? err.message : err);
        });

        // One-time import of the October 2026 blog batch (src/seed/blog-drafts).
        // Recorded in bootstrap_runs after success, so it never re-runs.
        ensureBlogDrafts().catch((err) => {
            console.error("Blog drafts import failed (non-fatal):", err && err.message ? err.message : err);
        });

        app.listen( PORT,()=>{
            console.log(`server connected on port ${PORT}`);
        })

        // Disable with RECONCILE_ENABLED=false (local/test runs must never settle donations).
        if (process.env.RECONCILE_ENABLED !== "false") startReconciliationJob();

        // Every successful donation gets pushed to DCC until it has a receipt
        // number; the WhatsApp receipt follows. Disable with DCC_SWEEP_ENABLED=false.
        startDccSweepJob();

        // Auto-tracking sync: watch courier feeds (Delhivery / DTDC /
        // Bluedart / India Post) for shipped orders and flip them to
        // Delivered when the courier reports delivery. Disable with
        // TRACKING_SYNC_ENABLED=false.
        startTrackingSyncJob();

        // In-process scheduler for pending-transaction WhatsApp reminders.
        // Mirrors the Annadana/Subhojanam reminder flow so pending donations
        // get nudged without needing any external cron setup. Disable with
        // PENDING_REMINDER_ENABLED=false if you prefer to drive it purely via
        // the /api/internal/send-pending-reminders endpoint from an external
        // cron instead. The whatsappPendingReminderSent flag makes it
        // idempotent regardless.
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
                            console.log(`Pending reminders pass: ${result.checked} checked, ${result.sent} sent, ${result.failed} failed`);
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
}

startServer()
