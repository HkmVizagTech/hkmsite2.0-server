/**
 * Numbers donations in two separate running series (see src/utils/donationSeries.js): the /donations page
 * family ("donations") and every other page ("seva"). 1 = the oldest donation of that series.
 *
 *   node scripts/backfill-donation-serial.js                       dry run of the default mode, writes nothing
 *   node scripts/backfill-donation-serial.js --apply               default mode: number donations that have no series number yet
 *   node scripts/backfill-donation-serial.js --renumber            dry run of the one-time conversion
 *   node scripts/backfill-donation-serial.js --renumber --apply    one-time conversion: renumber EVERY donation per series
 *
 * Default mode only touches donations without a series number, reserving its block of numbers atomically from the
 * series counter, so it is safe to run while the site is taking donations and safe to run again.
 * --renumber is for converting the first version (one global number across all pages) to per-series numbers:
 * it drops the old global unique index, then numbers each series 1..N by creation date and sets the counters.
 * Run it once, with the new server code already deployed, then run the default mode once more to pick up any
 * donation that arrived while it ran.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const BATCH = 1000;
const APPLY = process.argv.includes("--apply");
const RENUMBER = process.argv.includes("--renumber");
const SERIES = ["donations", "seva"];

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false }); // no index builds from this script
  const host = new URL(process.env.MONGO_URI.replace(/^mongodb(\+srv)?:/, "http:")).host;
  console.log(`Connected to ${host} (${RENUMBER ? "renumber" : "fill missing"}, ${APPLY ? "APPLY" : "dry run"})`);

  const { seriesOf, counterName } = require("../src/utils/donationSeries");
  const db = mongoose.connection.db;
  const col = db.collection("donations");
  const counters = db.collection("counters");

  // Reads only what's needed to decide the series and the order.
  const load = async (filter) => {
    const rows = await col.find(filter, { projection: { sourcePage: 1, type: 1, createdAt: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
    const by = { donations: [], seva: [] };
    for (const r of rows) by[seriesOf(r)].push(r._id);
    return by;
  };

  const flushWrites = async (ops) => {
    if (!ops.length) return 0;
    const r = await col.bulkWrite(ops, { ordered: false });
    return r.modifiedCount;
  };

  if (RENUMBER) {
    const all = await load({});
    for (const s of SERIES) console.log(`  series "${s}": ${all[s].length} donations -> 1..${all[s].length}`);
    const oldIdx = (await col.indexes()).find((i) => i.name === "uniq_serialNo");
    console.log(`old global unique index present: ${!!oldIdx}`);
    if (!APPLY) { console.log("Dry run only. Re-run with --renumber --apply to write."); return; }

    if (oldIdx) { await col.dropIndex("uniq_serialNo"); console.log("dropped old index uniq_serialNo"); }
    for (const s of SERIES) {
      let done = 0, ops = [];
      for (let i = 0; i < all[s].length; i++) {
        ops.push({ updateOne: { filter: { _id: all[s][i] }, update: { $set: { serialNo: i + 1, serialSeries: s } } } });
        if (ops.length >= BATCH) { done += await flushWrites(ops); ops = []; console.log(`  ${s}: ${done}/${all[s].length}`); }
      }
      done += await flushWrites(ops);
      // The counter starts (or restarts) at the last number given, so the next donation is N + 1.
      await counters.updateOne({ _id: counterName(s) }, { $set: { seq: all[s].length } }, { upsert: true });
      console.log(`  ${s}: numbered ${all[s].length}; counter set to ${all[s].length}`);
    }
    return;
  }

  // Default mode: only donations that have no series number yet.
  const missing = await load({ serialSeries: { $exists: false } });
  for (const s of SERIES) console.log(`  series "${s}": ${missing[s].length} without a number`);
  if (!missing.donations.length && !missing.seva.length) { console.log("Nothing to do."); return; }
  if (!APPLY) { console.log("Dry run only. Re-run with --apply to write."); return; }

  for (const s of SERIES) {
    const ids = missing[s];
    if (!ids.length) continue;
    // Reserve [start, start + ids.length - 1] in one atomic step.
    const after = await counters.findOneAndUpdate({ _id: counterName(s) }, { $inc: { seq: ids.length } }, { upsert: true, returnDocument: "after" });
    let next = after.seq - ids.length + 1;
    console.log(`  ${s}: reserved ${next} - ${after.seq}`);
    let done = 0, ops = [];
    for (const id of ids) {
      ops.push({ updateOne: { filter: { _id: id, serialSeries: { $exists: false } }, update: { $set: { serialNo: next++, serialSeries: s } } } });
      if (ops.length >= BATCH) { done += await flushWrites(ops); ops = []; }
    }
    done += await flushWrites(ops);
    console.log(`  ${s}: numbered ${done}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
