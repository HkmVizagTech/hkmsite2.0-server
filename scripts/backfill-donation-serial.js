/**
 * Gives every donation that has no `serialNo` a permanent running number, oldest first (1 = the first
 * donation ever made), and moves the "donation" counter past them so new donations carry on from there.
 *
 *   node scripts/backfill-donation-serial.js            # dry run: reports what it WOULD do, writes nothing
 *   node scripts/backfill-donation-serial.js --apply    # does it
 *
 * Safe to run again: it only touches donations without a number, so after a first run it picks up any
 * donation created in the gap before the new code was live. It reserves its block of numbers atomically
 * from the shared counter, so it can run while the site is taking donations without handing out a number twice.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const BATCH = 500;
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false }); // no index builds from this script
  const { donationModel } = require("../src/models/donation.model"); // after connecting, so its indexes build
  const host = new URL(process.env.MONGO_URI.replace(/^mongodb(\+srv)?:/, "http:")).host;
  console.log(`Connected to ${host} (${APPLY ? "APPLY" : "dry run"})`);

  const missing = await donationModel.countDocuments({ serialNo: { $exists: false } });
  const numbered = await donationModel.countDocuments({ serialNo: { $exists: true } });
  const counter = await mongoose.connection.db.collection("counters").findOne({ _id: "donation" });
  console.log(`donations without a number: ${missing}; already numbered: ${numbered}; counter: ${counter ? counter.seq : "(none yet)"}`);
  if (!missing) { console.log("Nothing to do."); return; }
  if (!APPLY) {
    const first = await donationModel.findOne({ serialNo: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).select("createdAt donorName").lean();
    const last = await donationModel.findOne({ serialNo: { $exists: false } }).sort({ createdAt: -1, _id: -1 }).select("createdAt donorName").lean();
    console.log("oldest to number:", first && first.createdAt, "| newest to number:", last && last.createdAt);
    console.log("Dry run only. Re-run with --apply to write.");
    return;
  }

  // Reserve [start, start + missing - 1] in one atomic step.
  const counters = mongoose.connection.db.collection("counters");
  const after = await counters.findOneAndUpdate({ _id: "donation" }, { $inc: { seq: missing } }, { upsert: true, returnDocument: "after" });
  let next = after.seq - missing + 1;
  console.log(`reserved ${next} - ${after.seq}`);

  let done = 0;
  const cursor = donationModel.find({ serialNo: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).select("_id").lean().cursor();
  let ops = [];
  const flush = async () => {
    if (!ops.length) return;
    const r = await donationModel.bulkWrite(ops, { ordered: false });
    done += r.modifiedCount;
    ops = [];
    console.log(`  numbered ${done}/${missing}`);
  };
  for await (const d of cursor) {
    if (next > after.seq) break; // a donation arrived mid-run; it will be picked up on the next run
    ops.push({ updateOne: { filter: { _id: d._id, serialNo: { $exists: false } }, update: { $set: { serialNo: next++ } } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  console.log(`Done. ${done} donations numbered.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
