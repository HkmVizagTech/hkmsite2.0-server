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

require("dotenv").config();

const mongoose = require("mongoose");
const { connectDb } = require("./src/config/db");
const { donationModel } = require("./src/models/donation.model");

const MAX_AGE_HOURS = Number(process.env.PENDING_REMINDER_MAX_AGE_HOURS || 24);

async function main() {
  const apply = process.argv.includes("--apply");
  const floor = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000);

  await connectDb();

  const filter = {
    status: { $in: ["pending", "failed"] },
    createdAt: { $lt: floor },
    whatsappPendingReminderSent: { $ne: true },
  };

  const total = await donationModel.countDocuments(filter);
  const byStatus = await donationModel.aggregate([
    { $match: filter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  console.log(`Cutoff: donations created before ${floor.toISOString()} (older than ${MAX_AGE_HOURS}h)`);
  for (const row of byStatus) console.log(`  ${row._id}: ${row.count}`);
  console.log(`  total: ${total}`);

  if (!total) {
    console.log("\nNothing to backfill.");
  } else if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to mark these as already reminded.");
  } else {
    const res = await donationModel.updateMany(filter, {
      $set: { whatsappPendingReminderSent: true },
    });
    console.log(`\nMarked ${res.modifiedCount} donation(s) as already reminded. They will never be messaged.`);
  }

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err.message);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
