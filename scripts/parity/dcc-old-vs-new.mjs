import "../../src/config/timezone.js";
import { createRequire } from "node:module";
import { MongoClient } from "mongodb";
import { connectDb, closeDb } from "../../src/db/pg.js";
import { donations } from "../../src/db/tables.js";
import { buildDccPayload as buildNew } from "../../src/services/dcc.service.js";

const BASE = process.env.BASELINE_DIR;
const require = createRequire(`${BASE}/package.json`);
const mongoose = require("mongoose");
await mongoose.connect(process.env.SRC_MONGO_URI);
const { donationModel } = require(`${BASE}/src/models/donation.model.js`);
const { buildDccPayload: buildOld } = require(`${BASE}/src/services/dcc.service.js`);
await connectDb();

const fields = ["donorName", "donorPhone", "donorEmail", "gender", "PAN", "amount", "accountType", "sevaCategory", "sevaSubCategory", "sevaSubCategoryCode", "modeOfPayment", "gatewayPaymentId", "transactionDate", "enrolledBy", "address.fullAddress", "address.state", "address.city", "address.pinCode"];
const get = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
const norm = (v) => (v === undefined || v === null || v === "" ? null : String(v));
const mk = () => Object.fromEntries(fields.map((f) => [f, { diff: 0, ex: [] }]));
const modes = { hydrated: mk(), lean: mk() };
let total = 0, same = { hydrated: 0, lean: 0 };
const ids = (await donationModel.find({ dccPayload: { $ne: null } }).select("_id").lean()).map((d) => String(d._id));
for (let i = 0; i < ids.length; i += 300) {
  const chunk = ids.slice(i, i + 300);
  const oldH = new Map((await donationModel.find({ _id: { $in: chunk } })).map((d) => [String(d._id), d]));
  const oldL = new Map((await donationModel.find({ _id: { $in: chunk } }).lean()).map((d) => [String(d._id), d]));
  const newH = new Map((await donations.find({ _id: { $in: chunk } })).map((d) => [d._id, d]));
  const newL = new Map((await donations.find({ _id: { $in: chunk } }, { lean: true })).map((d) => [d._id, d]));
  for (const id of chunk) {
    if (!newH.has(id) || !oldH.has(id)) continue;
    total++;
    const gw = oldL.get(id)?.dccPayload?.gatewayPaymentId;
    for (const [mode, o, n] of [["hydrated", oldH, newH], ["lean", oldL, newL]]) {
      const a = buildOld(o.get(id), gw), b = buildNew(n.get(id), gw);
      let ok = true;
      for (const f of fields) if (norm(get(a, f)) !== norm(get(b, f))) { ok = false; modes[mode][f].diff++; if (modes[mode][f].ex.length < 2) modes[mode][f].ex.push({ id, old: get(a, f), new: get(b, f) }); }
      if (ok) same[mode]++;
    }
  }
}
console.log(`donations replayed through BOTH the old and the new DCC request builder: ${total}`);
for (const m of ["hydrated", "lean"]) {
  console.log(`  ${m} documents: identical request in every field: ${same[m]}/${total}`);
  for (const [f, s] of Object.entries(modes[m])) if (s.diff) console.log(`     field ${f}: ${s.diff} differ, e.g. ${JSON.stringify(s.ex[0])}`);
}
await mongoose.disconnect(); await closeDb();
