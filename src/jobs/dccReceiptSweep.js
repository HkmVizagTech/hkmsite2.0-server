import { sweepDccReceipts } from "../services/dccSweep.service.js";

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

export { startDccSweepJob, runDccSweep };
