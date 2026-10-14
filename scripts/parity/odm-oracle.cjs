// Oracle for src/domain/odm.js: the real Mongoose 8 of the baseline checkout, run against a scratch database of the
// local mongod (never Atlas). BASELINE defaults to ../../../.localdb/baseline.
const path = require("node:path");
const B = process.env.BASELINE || path.resolve(__dirname, "../../../.localdb/baseline");
const mongoose = require(B + "/node_modules/mongoose");
const models = {};
for (const f of [
  "blog",
  "event",
  "registration",
  "gallery",
  "heroBanner",
  "importantDate",
  "media",
  "siteContent",
  "donationPage",
  "contactMessage",
  "darshan",
  "templeDevotee",
  "volunteer",
  "festivalShowcase",
  "festivalDonation",
  "campaigner",
  "user",
  "donorIssue",
]) {
  Object.assign(models, require(`${B}/src/models/${f}.model.js`));
}
let connected;
async function connect() {
  if (!connected) connected = mongoose.connect(process.env.ORACLE_MONGO_URI || "mongodb://127.0.0.1:27018/scratch_odm");
  await connected;
  return mongoose;
}
module.exports = { models, connect, mongoose };
