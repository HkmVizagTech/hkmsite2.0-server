
require("dotenv").config();
const { app } = require("./app");
const { connectDb } = require("./src/config/db");
const PORT = process.env.PORT || 8080;

const startServer =async()=>{
    try {
        await connectDb()

        app.listen( PORT,()=>{
            console.log(`server connected on port ${PORT}`);
        })

        // In-process scheduler for pending-transaction WhatsApp reminders.
        // Mirrors the Annadana/Subhojanam reminder flow so pending donations
        // get nudged without needing any external cron setup. Disable with
        // PENDING_REMINDER_ENABLED=false if you prefer to drive it purely via
        // the /api/internal/send-pending-reminders endpoint from an external
        // cron instead. The whatsappPendingReminderSent flag makes it
        // idempotent regardless.
        if (process.env.PENDING_REMINDER_ENABLED !== "false") {
            const { runPendingReminders } = require("./src/services/pendingReminder.service");
            const intervalMinutes = Number(process.env.PENDING_REMINDER_INTERVAL_MINUTES || 10);
            const run = () => {
                runPendingReminders()
                    .then((result) => {
                        if (result && result.checked > 0) {
                            console.log(`Pending reminders pass: ${result.checked} checked, ${result.sent} sent, ${result.failed} failed`);
                        }
                    })
                    .catch((err) => {
                        console.error("Pending reminders scheduler error:", err && err.stack ? err.stack : err);
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
