const { sweepDccReceipts } = require("../services/dccSweep.service");

// Pushes every successful donation that still has no DCC receipt number, and
// sends the WhatsApp receipt as soon as one comes back. See
// services/dccSweep.service.js for which donations are pushed and when.
// Disable with DCC_SWEEP_ENABLED=false.
const INTERVAL_MS = Number(process.env.DCC_SWEEP_INTERVAL_MINUTES || 10) * 60 * 1000;

async function runDccSweep() {
  try {
    const s = await sweepDccReceipts({ limit: Number(process.env.DCC_SWEEP_BATCH || 25) });
    if (s.pushed > 0 || s.staleLocks > 0) {
      console.log(
        `[dcc-sweep] pushed ${s.pushed}, got ${s.receipts} receipt(s) (${s.recovered} already in DCC), ` +
        `${s.whatsappSent} WhatsApp sent, ${s.failed} still failing, ${s.staleLocks} interrupted push(es) released`
      );
    }
  } catch (err) {
    console.error("[dcc-sweep] run failed:", err && err.message ? err.message : err);
  }
}

function startDccSweepJob() {
  if (process.env.DCC_SWEEP_ENABLED === "false") return;
  setTimeout(runDccSweep, 2 * 60 * 1000); // after boot, clear of startup traffic
  setInterval(runDccSweep, INTERVAL_MS);
  console.log(`[dcc-sweep] DCC receipt sweep scheduled every ${INTERVAL_MS / 60000} min`);
}

module.exports = { startDccSweepJob, runDccSweep };
