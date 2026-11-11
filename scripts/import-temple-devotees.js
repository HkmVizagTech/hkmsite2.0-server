// Imports the temple's devotee list (CSV: Id,Name,Code,MobileNumber,Email) into templeDevotees.
// Id = DCC enrolled-by ID. Matches existing devotees by DCC id (or name), updates them, and adds the rest.
// Rows with no name are stored under their code so their links still work. "NULL" is treated as empty.
// Usage: node scripts/import-temple-devotees.js <file.csv> [--write]   (without --write it only prints the plan)
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const { templeDevoteeModel } = require("../src/models/templeDevotee.model");

const file = process.argv[2];
const write = process.argv.includes("--write");
if (!file) { console.error("usage: node scripts/import-temple-devotees.js <file.csv> [--write]"); process.exit(1); }

const clean = (v) => { const s = String(v == null ? "" : v).trim(); return /^null$/i.test(s) ? "" : s; };
const rows = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => {
  const [id, name, code, mobile, email] = l.split(",").map(clean);
  return { id: Number(id), name, code: code.toUpperCase(), mobile, email: email.toLowerCase() };
}).filter((r) => Number.isFinite(r.id) && r.code);

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  let add = 0, upd = 0;
  for (const r of rows) {
    const existing = (await templeDevoteeModel.findOne({ dccEnrolledById: r.id })) || (r.name ? await templeDevoteeModel.findOne({ name: r.name, dccEnrolledById: null }) : null);
    const doc = { name: r.name || r.code, dccEnrolledById: r.id, code: r.code, mobile: r.mobile, email: r.email };
    if (existing) {
      console.log(`update  ${String(r.id).padStart(3)} ${r.code.padEnd(5)} ${doc.name}  (was "${existing.name}", id ${existing.dccEnrolledById})`);
      if (write) { Object.assign(existing, doc); await existing.save(); }
      upd++;
    } else {
      console.log(`add     ${String(r.id).padStart(3)} ${r.code.padEnd(5)} ${doc.name}`);
      if (write) await templeDevoteeModel.create({ ...doc, status: "active" });
      add++;
    }
  }
  console.log(`${write ? "done" : "dry run"}: ${add} to add, ${upd} to update${write ? "" : " (run again with --write to save)"}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
