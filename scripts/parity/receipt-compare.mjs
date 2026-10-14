#!/usr/bin/env node
// Generates the receipt PDF with the baseline (Mongo) and new (Postgres) code for the same donations and compares the
// decoded page content streams, metadata and embedded fonts.
//   node scripts/parity/receipt-compare.mjs [count=12]
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from "pdf-lib";
import { MongoClient } from "mongodb";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = path.resolve(ROOT, "../.localdb/baseline");
const count = Number(process.argv[2] || 12);
process.env.SRC_MONGO_URI ||= "mongodb://127.0.0.1:27018/m_eq-payments";
process.env.DATABASE_URL ||= "postgres://hkm@localhost:5433/pg_eq-payments";
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const d = mongo.db().collection("donations");
const picks = [
  ...(await d.find({ receiptNumber: { $exists: true }, createdAt: { $lt: new Date(Date.now() - 864e5) }, campaignerSlug: { $exists: true, $ne: null } }).sort({ _id: -1 }).limit(4).toArray()),
  ...(await d.find({ receiptNumber: { $exists: true }, createdAt: { $lt: new Date(Date.now() - 864e5) }, donorRecordId: { $exists: true } }).sort({ _id: -1 }).limit(count).toArray()),
  ...(await d.find({ receiptNumber: { $exists: true }, createdAt: { $lt: new Date(Date.now() - 864e5) }, donorRecordId: { $exists: false } }).sort({ _id: 1 }).limit(4).toArray()),
];
const ids = [...new Set(picks.map((x) => String(x._id)))].slice(0, count + 8);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcpt-"));
const run = (cwd, args, env) => spawnSync("node", args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 180000 });
const common = `const ids=${JSON.stringify(ids)};const fs=require("fs");`;
const b = run(BASELINE, ["-e", `${common}const m=require("mongoose");(async()=>{await m.connect(process.env.MONGO_URI);const {generateReceiptBuffer}=require("./src/services/receipt.service");for(const id of ids){try{fs.writeFileSync(process.env.OUT+"/b-"+id+".pdf",await generateReceiptBuffer(id))}catch(e){fs.writeFileSync(process.env.OUT+"/b-"+id+".err",e.message)}}process.exit(0)})()`], { MONGO_URI: process.env.SRC_MONGO_URI, OUT: tmp });
const n = run(ROOT, ["--input-type=module", "-e", `import fs from "fs";import {connectDb,closeDb} from "./src/db/pg.js";await connectDb();const {generateReceiptBuffer}=await import("./src/services/receipt.service.js");for(const id of ${JSON.stringify(ids)}){try{fs.writeFileSync(process.env.OUT+"/n-"+id+".pdf",await generateReceiptBuffer(id))}catch(e){fs.writeFileSync(process.env.OUT+"/n-"+id+".err",e.message)}}await closeDb();process.exit(0)`], { DATABASE_URL: process.env.DATABASE_URL, OUT: tmp });
if (b.status || n.status) console.log("child stderr", (b.stderr + n.stderr).slice(-400));

const streams = async (file) => {
  const doc = await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false });
  const out = [];
  for (const page of doc.getPages()) {
    const c = page.node.get(PDFName.of("Contents"));
    const refs = c instanceof PDFArray ? c.asArray() : [c];
    for (const r of refs) {
      const s = doc.context.lookup(r);
      if (s instanceof PDFRawStream) {
        let buf = Buffer.from(s.contents);
        try { buf = zlib.inflateSync(buf); } catch {}
        out.push(buf.toString("latin1"));
      }
    }
  }
  return { text: out.join("\n"), pages: doc.getPageCount(), title: doc.getTitle(), author: doc.getAuthor(), producer: doc.getProducer() };
};
let bad = 0;
for (const id of ids) {
  const bf = path.join(tmp, `b-${id}.pdf`);
  const nf = path.join(tmp, `n-${id}.pdf`);
  if (!fs.existsSync(bf) || !fs.existsSync(nf)) {
    const be = fs.existsSync(path.join(tmp, `b-${id}.err`)) ? fs.readFileSync(path.join(tmp, `b-${id}.err`), "utf8") : "ok";
    const ne = fs.existsSync(path.join(tmp, `n-${id}.err`)) ? fs.readFileSync(path.join(tmp, `n-${id}.err`), "utf8") : "ok";
    const same = be === ne;
    if (!same) bad++;
    console.log(`${same ? "PASS" : "FAIL"}  ${id} no pdf on one/both sides: baseline=${be} new=${ne}`);
    continue;
  }
  const [x, y] = [await streams(bf), await streams(nf)];
  const same = x.text === y.text && x.pages === y.pages && x.title === y.title && x.author === y.author;
  if (!same) {
    bad++;
    const xs = x.text.split("\n"), ys = y.text.split("\n");
    const i = xs.findIndex((l, k) => l !== ys[k]);
    console.log(`FAIL  ${id} first differing content line ${i}: baseline=${xs[i]?.slice(0, 120)} new=${ys[i]?.slice(0, 120)}`);
  } else console.log(`PASS  ${id} content streams identical (${x.text.length} chars, ${fs.statSync(bf).size}/${fs.statSync(nf).size} bytes)`);
}
console.log(bad ? `${bad} differ` : "all receipts identical");
await mongo.close();
process.exit(bad ? 1 : 0);
