// Daily "Laxmi Points" feed to Airtable.
//
// Once a day, shortly after 1 AM India time, the previous calendar day (00:00 to 24:00 IST) is totalled and one row
// is created in the Airtable table:
//   Date               the day that was totalled (YYYY-MM-DD, IST), so the run at 1 AM on the 1st reports the 31st
//   Laxmi Points       confirmed donation amount that day divided by 10 (Rs. 10,000 -> 1000), rounded to a whole number
//   Number of Contacts distinct donor mobile numbers among those donations (the same number donating twice counts once)
//   Devotees           a fixed Airtable record link (the same every day)
//
// "Confirmed" means status "completed", counted by the day the donation was created. Donations with no usable mobile
// number add to the points but not to the contacts. It never posts twice for a date: each date is claimed in the
// airtable_laxmi_syncs collection (unique _id) before the request, so restarts, several instances and retries are safe.
//
// Needs AIRTABLE_TOKEN (never commit it). Without it the job does nothing, so a developer's local server that points
// at the live database cannot post by accident. Disable with AIRTABLE_LAXMI_ENABLED=false.
const axios = require("axios");
const mongoose = require("mongoose");
const { donationModel } = require("../models/donation.model");
const { cleanMobile, isValidMobile } = require("../utils/mobile");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const POINTS_DIVISOR = 10;
const MAX_ATTEMPTS = 12;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const config = () => ({
  token: process.env.AIRTABLE_TOKEN,
  baseId: process.env.AIRTABLE_BASE_ID || "appwPeoeh8VkGgbST",
  tableId: process.env.AIRTABLE_LAXMI_TABLE_ID || "tblIYjbX4VHqTLbLR",
  devoteeId: process.env.AIRTABLE_LAXMI_DEVOTEE_ID || "recgMFkMxSgWaI0DP",
});

const pad = (n) => String(n).padStart(2, "0");

// The India-time calendar date ("YYYY-MM-DD") of an instant.
const istDateOf = (instant = new Date()) => {
  const d = new Date(instant.getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const istHourOf = (instant = new Date()) => new Date(instant.getTime() + IST_OFFSET_MS).getUTCHours();

// [start, end) of an India-time calendar day, as real instants.
const istDayRange = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
};

const yesterdayIst = (now = new Date()) => istDateOf(new Date(now.getTime() - DAY_MS));

async function computeDay(dateStr) {
  const { start, end } = istDayRange(dateStr);
  const [row] = await donationModel.aggregate([
    { $match: { status: "completed", createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, total: { $sum: "$amount" }, donations: { $sum: 1 }, mobiles: { $push: "$donorMobile" } } },
  ]);
  const total = row ? row.total : 0;
  const contacts = new Set();
  for (const raw of row ? row.mobiles : []) {
    const mobile = cleanMobile(raw);
    if (isValidMobile(mobile)) contacts.add(mobile);
  }
  return {
    date: dateStr,
    donations: row ? row.donations : 0,
    totalAmount: total,
    laxmiPoints: Math.round(total / POINTS_DIVISOR),
    contacts: contacts.size,
  };
}

async function postToAirtable(day) {
  const { token, baseId, tableId, devoteeId } = config();
  const res = await axios.post(
    `https://api.airtable.com/v0/${baseId}/${tableId}`,
    {
      records: [
        {
          fields: {
            Date: day.date,
            "Laxmi Points": day.laxmiPoints,
            Devotees: [devoteeId],
            "Number of Contacts": day.contacts,
          },
        },
      ],
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  const record = res.data && res.data.records && res.data.records[0];
  if (!record || !record.id) throw new Error("Airtable answered without a record id");
  return record.id;
}

const syncs = () => mongoose.connection.collection("airtable_laxmi_syncs");

// Claims the date for this run. False when it is already done, or another run has it.
async function claimDate(dateStr) {
  const now = new Date();
  try {
    await syncs().insertOne({ _id: dateStr, status: "sending", attempts: 1, startedAt: now });
    return true;
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
  }
  const r = await syncs().updateOne(
    {
      _id: dateStr,
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [{ status: "failed" }, { status: "sending", startedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } }],
    },
    { $set: { status: "sending", startedAt: now }, $inc: { attempts: 1 } }
  );
  return r.modifiedCount === 1;
}

// Totals one India-time date and posts it, unless that date was already posted. Returns what happened.
async function syncLaxmiPoints(dateStr) {
  const { token } = config();
  if (!token) return { skipped: "AIRTABLE_TOKEN not set" };
  if (!(await claimDate(dateStr))) return { skipped: "already sent, or being sent" };
  try {
    const day = await computeDay(dateStr);
    const recordId = await postToAirtable(day);
    await syncs().updateOne({ _id: dateStr }, { $set: { status: "done", doneAt: new Date(), airtableRecordId: recordId, ...day }, $unset: { error: "" } });
    return { sent: true, recordId, ...day };
  } catch (err) {
    // Never log the token; Airtable's own error text is what helps.
    const detail = err && err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    await syncs().updateOne({ _id: dateStr }, { $set: { status: "failed", error: String(detail), failedAt: new Date() } });
    return { failed: true, error: detail };
  }
}

let running = false;
async function runLaxmiCheck() {
  if (running) return;
  if (istHourOf() < 1) return; // the day's total is posted from 01:00 IST on
  running = true;
  try {
    const dateStr = yesterdayIst();
    const result = await syncLaxmiPoints(dateStr);
    if (result.sent) console.log(`[airtable-laxmi] ${dateStr}: ${result.donations} donations, Rs. ${result.totalAmount} -> ${result.laxmiPoints} points, ${result.contacts} contacts (record ${result.recordId})`);
    else if (result.failed) console.error(`[airtable-laxmi] ${dateStr} failed: ${result.error}`);
  } catch (err) {
    console.error("[airtable-laxmi] error:", err && err.message ? err.message : err);
  } finally {
    running = false;
  }
}

function startAirtableLaxmiJob() {
  if (process.env.AIRTABLE_LAXMI_ENABLED === "false") return;
  if (!process.env.AIRTABLE_TOKEN) {
    console.log("[airtable-laxmi] AIRTABLE_TOKEN not set; daily Laxmi Points job is off");
    return;
  }
  setTimeout(runLaxmiCheck, 60 * 1000);
  setInterval(runLaxmiCheck, CHECK_INTERVAL_MS);
  console.log("[airtable-laxmi] daily Laxmi Points job scheduled (posts from 01:00 IST)");
}

module.exports = { startAirtableLaxmiJob, syncLaxmiPoints, computeDay, istDateOf, istDayRange, yesterdayIst };
