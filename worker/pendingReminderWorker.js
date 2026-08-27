// worker/pendingReminderWorker.js
//
// Standalone script: runs ONE pending-transaction WhatsApp reminder pass and
// exits. Mirrors the Annadana/Subhojanam sendPendingWhatsappReminders script.
//
//   node worker/pendingReminderWorker.js
//
// Useful for manual runs or an external cron line. The in-process scheduler
// in index.js and the /api/internal/send-pending-reminders endpoint call the
// same logic, so all three are interchangeable — the whatsappPendingReminderSent
// flag prevents double-sending no matter which mechanism runs.

const { connectDb } = require("../src/config/db");
const { runPendingReminders } = require("../src/services/pendingReminder.service");

async function main() {
  await connectDb();
  const result = await runPendingReminders();
  console.log("Pending reminders pass complete:", result);
  await new Promise((r) => setTimeout(r, 500)); // let logs flush
  process.exit(0);
}

main().catch((err) => {
  console.error("Pending reminder worker failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
