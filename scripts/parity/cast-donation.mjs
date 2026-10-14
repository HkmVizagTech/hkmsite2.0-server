#!/usr/bin/env node
// Differential test: src/domain/paymentCast.js against the real Mongoose donation model (baseline tree).
//   node scripts/parity/cast-donation.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = path.resolve(ROOT, "../.localdb/baseline");
const require = createRequire(path.join(BASELINE, "index.js"));
const { donationModel } = require(path.join(BASELINE, "src/models/donation.model.js"));
const { castPaymentDonation } = await import(path.join(ROOT, "src/domain/paymentCast.js"));

const FIELDS = [
  "donorName",
  "donorEmail",
  "donorMobile",
  "amount",
  "type",
  "message",
  "sourcePage",
  "sevaName",
  "sevaSlug",
  "bannerImage",
  "legacySevaId",
  "paymentAccount",
  "festivalId",
  "festivalSlug",
  "campaignerSlug",
  "dccEnrolledById",
  "panNumber",
  "certificate",
  "sevakName",
  "sevaDate",
  "dob",
  "wantPrasadam",
  "prasadamAddress",
  "razorpayOrderId",
  "subscriptionId",
  "isRecurring",
  "metaEventId",
  "metaFbp",
  "metaFbc",
  "metaClientIp",
  "metaUserAgent",
];
const VALUES = [
  null,
  "",
  " ",
  "abc",
  "150",
  " 12 ",
  "12abc",
  "1e3",
  "0x10",
  "Infinity",
  "-5",
  "1.5",
  0,
  1,
  -1,
  1.5,
  150,
  1e21,
  2 ** 53,
  true,
  false,
  "true",
  "false",
  "yes",
  "no",
  "0",
  "1",
  [],
  [1],
  ["a"],
  {},
  { a: 1 },
  { _id: "x" },
  { _id: 5 },
  "507f1f77bcf86cd799439011",
  "507F1F77BCF86CD799439011",
  "abcdefghijkl",
  "abcdefghijké",
  "x".repeat(300),
  { doorNo: 5, city: "Vizag", foo: 1 },
  { city: { a: 1 } },
  { country: null },
  { toString: 5 },
  "it's",
  'a"b',
];

const mongoose = async (input) => {
  const base = { donorName: "n", amount: 150 };
  const doc = new donationModel({ ...base, ...input });
  const err = doc.validateSync();
  if (err) return { error: err.message };
  const o = doc.toObject({ depopulate: true, minimize: true });
  const keep = {};
  const DEFAULTS = {
    certificate: false,
    wantPrasadam: false,
    isRecurring: false,
    type: "General",
    dccEnrolledById: null,
  };
  for (const k of [...FIELDS, "prasadamAddress"]) {
    if (o[k] === undefined) continue;
    if (!(k in input) && k in DEFAULTS && o[k] === DEFAULTS[k]) continue;
    keep[k] = o[k];
  }
  return { doc: JSON.parse(JSON.stringify(keep)) };
};
const mine = (input) => {
  const base = { donorName: "n", amount: 150 };
  try {
    const out = castPaymentDonation({ ...base, ...input });
    const o = JSON.parse(JSON.stringify(out));
    if (o.prasadamAddress && o.prasadamAddress.country === null) {
      const { country, ...rest } = o.prasadamAddress;
      o.prasadamAddress = Object.keys(rest).length ? rest : undefined;
    } else if (!("prasadamAddress" in input)) delete o.prasadamAddress;
    return { doc: o };
  } catch (e) {
    return { error: e.message };
  }
};
const canon = (r) => {
  if (r.error) return JSON.stringify(r);
  const d = { ...r.doc };
  if (d.prasadamAddress === null) delete d.prasadamAddress;
  if (d.prasadamAddress) {
    const { country, ...rest } = d.prasadamAddress;
    d.prasadamAddress = rest;
    if (!Object.keys(rest).length) delete d.prasadamAddress;
  }
  if (d.prasadamAddress === null) delete d.prasadamAddress;
  return JSON.stringify({ doc: Object.fromEntries(Object.entries(d).sort(([a], [b]) => (a < b ? -1 : 1))) });
};

let bad = 0;
let total = 0;
const check = async (input) => {
  total++;
  const a = canon(await mongoose(input));
  const b = canon(mine(input));
  if (a !== b) {
    bad++;
    if (bad <= 25) console.log("DIFF", JSON.stringify(input), "\n  mongoose:", a, "\n  mine:    ", b);
  }
};

for (const f of FIELDS) for (const v of VALUES) await check({ [f]: v });
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
for (let i = 0; i < 4000; i++) {
  const input = {};
  const n = 1 + Math.floor(Math.random() * 4);
  for (let j = 0; j < n; j++) input[rnd(FIELDS)] = rnd(VALUES);
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  await check(reversed);
}
console.log(`${total} cases, ${bad} differences`);
process.exit(bad ? 1 : 0);
