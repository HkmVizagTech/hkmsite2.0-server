// Totals one India-time day for the Airtable Laxmi Points feed. Read-only unless --send is given.
//   node scripts/airtable-laxmi.js                     yesterday (IST), numbers only
//   node scripts/airtable-laxmi.js --date=2026-10-30   a chosen day, numbers only
//   node scripts/airtable-laxmi.js --date=2026-10-30 --send   post it (needs AIRTABLE_TOKEN; skips a date already sent)
require("dotenv").config();
const mongoose = require("mongoose");
const { computeDay, syncLaxmiPoints, yesterdayIst } = require("../src/services/airtableLaxmi.service");

(async () => {
  const arg = process.argv.find((a) => a.startsWith("--date="));
  const date = arg ? arg.split("=")[1] : yesterdayIst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use --date=YYYY-MM-DD");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  if (process.argv.includes("--send")) console.log(JSON.stringify(await syncLaxmiPoints(date)));
  else console.log(JSON.stringify(await computeDay(date)), "(not sent)");
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
