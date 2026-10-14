// One-time safety net: marks every OLD pending/failed donation as already
// reminded, so no donor is ever messaged about an attempt they abandoned
// long before this feature existed.
//
//   node backfill-mark-old-reminded.js          # dry run — counts only
//   node backfill-mark-old-reminded.js --apply  # actually writes
//
// The reminder job already refuses to look at anything older than
// PENDING_REMINDER_MAX_AGE_HOURS (default 24), so this is belt-and-braces:
// it makes the exclusion permanent, so that widening that window later — or
// running an old build — can never release a flood of stale reminders.

import "dotenv/config";

import { connectDb, closeDb, query, many } from "./src/db/pg.js";

const MAX_AGE_HOURS = Number(process.env.PENDING_REMINDER_MAX_AGE_HOURS || 24);

async function main() {
  const apply = process.argv.includes("--apply");
  const floor = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000);

  await connectDb();

  const where = "status = ANY($1) AND created_at < $2 AND whatsapp_pending_reminder_sent IS DISTINCT FROM true";
  const params = [["pending", "failed"], floor];

  const byStatus = await many(
    `SELECT status, count(*)::int AS count FROM donations WHERE ${where} GROUP BY status ORDER BY status`,
    params
  );
  const total = byStatus.reduce((n, r) => n + r.count, 0);

  console.log(`Cutoff: donations created before ${floor.toISOString()} (older than ${MAX_AGE_HOURS}h)`);
  for (const row of byStatus) console.log(`  ${row.status}: ${row.count}`);
  console.log(`  total: ${total}`);

  if (!total) {
    console.log("\nNothing to backfill.");
  } else if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to mark these as already reminded.");
  } else {
    const res = await query(
      `UPDATE donations SET whatsapp_pending_reminder_sent = true, updated_at = now() WHERE ${where}`,
      params
    );
    console.log(`\nMarked ${res.rowCount} donation(s) as already reminded. They will never be messaged.`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err.message);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
