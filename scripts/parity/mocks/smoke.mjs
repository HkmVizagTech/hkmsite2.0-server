#!/usr/bin/env node
// MOCKS=1 scripts/parity/env.sh up mocks 9900   (then, with SRC_MONGO_URI / DATABASE_URL exported as printed)
// node scripts/parity/mocks/smoke.mjs [envName=mocks] [basePort=9900]   (run `env.sh reset` first for a repeat run: OTP has a resend cooldown)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";
import sharp from "sharp";
import { sign, call, normalize, diff } from "../lib.mjs";
import { setState, resetMocks, readLog, payOrder, signWebhook, waitFor, compareLogs, summarize } from "./ctl.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envName = process.argv[2] || "mocks";
const base = Number(process.argv[3] || 9900);
const SERVERS = [
  { tag: "baseline", url: `http://localhost:${base}` },
  { tag: "new", url: `http://localhost:${base + 1}` },
];
process.env.SRC_MONGO_URI ||= `mongodb://127.0.0.1:27018/m_${envName}`;
process.env.DATABASE_URL ||= `postgres://hkm@localhost:5433/pg_${envName}`;

const { donations: pgDonations } = await import(pathToFileURL(`${ROOT}/src/db/tables.js`).href);
const { closeDb } = await import(pathToFileURL(`${ROOT}/src/db/pg.js`).href);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const mdb = mongo.db();

let failures = 0;
const check = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
};

const donorWithMobile = await mdb.collection("donors").findOne({ mobile: { $regex: /^\d{10}$/ } }, { sort: { _id: -1 } });
const adminUser = await mdb.collection("users").findOne({ role: "admin" });
const adminToken = sign({ userId: String(adminUser._id), role: "admin" });
const WEBHOOK_SECRET = "local-webhook-secret";

const readDonation = async (tag, id) => {
  if (tag === "baseline") {
    const { ObjectId } = await import("mongodb");
    return mdb.collection("donations").findOne({ _id: new ObjectId(id) });
  }
  return pgDonations.findById(id);
};

const VOLATILE = /^(_id|__v|createdAt|updatedAt|date|dccLastAttemptAt|dccSyncedAt|receiptGeneratedAt|whatsappReceiptSentAt|whatsappThankYouSentAt|metaPurchaseSentAt|donorRecordId|razorpayBody)$/;
const clean = (doc) => {
  const n = normalize(JSON.parse(JSON.stringify(doc)));
  const walk = (v, key = "") => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.test(k)).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "string") return v.replace(/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g, "<id>").replace(/receipt_\d+/g, "receipt_<ts>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>");
    return v;
  };
  return walk(n);
};

async function donationFlow(server, label, sourcePage, { dccFails = false } = {}) {
  const out = { label };
  const order = await call(server.url, {
    method: "POST",
    path: "/payments/order",
    body: { name: `Mock ${label}`, email: `mock-${label}@example.com`, mobile: donorWithMobile.mobile, amount: 501, sourcePage, sevaName: "Mock Seva" },
  });
  out.orderStatus = order.status;
  out.orderId = order.data?.orderId;
  out.donationId = String(order.data?.donationId);
  payOrder(envName, server.tag, out.orderId, { id: `pay_Mock${label}`, amount: 50100 });
  const body = JSON.stringify({
    entity: "event",
    event: "payment.captured",
    payload: { payment: { entity: { id: `pay_Mock${label}`, order_id: out.orderId, amount: 50100, status: "captured", method: "upi" } } },
  });
  const hook = await fetch(`${server.url}/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": signWebhook(WEBHOOK_SECRET, body) },
    body,
  });
  out.webhookStatus = hook.status;
  out.row = await waitFor(
    async () => {
      const d = await readDonation(server.tag, out.donationId);
      if (dccFails) return d?.status === "completed" && d.dccSyncStatus === "failed" ? d : null;
      return d?.status === "completed" && d.receiptNumber && (d.whatsappReceiptSentAt || d.whatsappReceiptError) ? d : null;
    },
    { label: `${server.tag} ${label} pipeline`, timeoutMs: 30000 }
  ).catch(async (e) => {
    console.log(`  ${server.tag} ${label}: ${e.message}`);
    return readDonation(server.tag, out.donationId);
  });
  return out;
}

const results = {};
for (const server of SERVERS) {
  resetMocks(envName, server.tag);
  const r = (results[server.tag] = {});
  r.gupshup = await donationFlow(server, "A", "seva-page");
  r.flaxxa = await donationFlow(server, "B", "donations");
  setState(envName, server.tag, { dcc: { failNext: 1, status: 500, body: { Message: "DCC scripted outage" } } });
  r.dccDown = await donationFlow(server, "C", "seva-page", { dccFails: true });
  await new Promise((res) => setTimeout(res, 2000));

  r.otp = await call(server.url, { method: "POST", path: "/donor-auth/send-otp", body: { mobile: donorWithMobile.mobile } });

  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c87828" } }).jpeg().toBuffer();
  const form = new FormData();
  form.append("upload", new Blob([jpeg], { type: "image/jpeg" }), "smoke.jpg");
  const up = await fetch(`${server.url}/blogs/upload-inline`, { method: "POST", headers: { authorization: `Bearer ${adminToken}` }, body: form });
  r.upload = { status: up.status, data: await up.json().catch(() => null) };
}

console.log("\n== flow results");
for (const server of SERVERS) {
  const r = results[server.tag];
  for (const k of ["gupshup", "flaxxa"]) {
    const d = r[k].row || {};
    check(r[k].orderStatus === 200 && r[k].webhookStatus === 200, `${server.tag} ${k}: order + webhook accepted`);
    check(d.status === "completed" && /^HKMI\|2026\|D\/VSP\|/.test(d.receiptNumber || ""), `${server.tag} ${k}: completed with DCC receipt ${d.receiptNumber}`);
    check(Boolean(d.whatsappReceiptSentAt) && !d.whatsappReceiptError, `${server.tag} ${k}: WhatsApp receipt sent via ${d.whatsappProvider} ${d.whatsappMessageId || ""}${d.whatsappReceiptError ? ` ERROR ${d.whatsappReceiptError}` : ""}`);
  }
  const c = r.dccDown.row || {};
  check(c.dccSyncStatus === "failed" && !c.receiptNumber, `${server.tag} dccDown: sync failed as scripted (${c.dccSyncError})`);
  check(r.otp.status === 200 && r.otp.data?.success, `${server.tag} otp: ${r.otp.status} ${JSON.stringify(r.otp.data)}`);
  check(r.upload.status === 200 && /pub-mock\.r2\.dev\/blogs\/inline\//.test(r.upload.data?.url || ""), `${server.tag} upload: ${r.upload.status} ${r.upload.data?.url || JSON.stringify(r.upload.data)}`);
}

console.log("\n== HTTP responses (old vs new)");
const respDiff = [];
for (const k of ["gupshup", "flaxxa", "dccDown"]) {
  const a = results.baseline[k];
  const b = results.new[k];
  const d = diff({ orderStatus: a.orderStatus, orderId: a.orderId, webhook: a.webhookStatus }, { orderStatus: b.orderStatus, orderId: b.orderId, webhook: b.webhookStatus });
  respDiff.push(...d.map((x) => `${k}: ${x}`));
}
const ud = diff(results.baseline.otp.data, results.new.otp.data);
respDiff.push(...ud.map((x) => `otp: ${x}`));
respDiff.push(...diff({ s: results.baseline.upload.status, u: results.baseline.upload.data?.url?.replace(/\d{13}/g, "<ts>") }, { s: results.new.upload.status, u: results.new.upload.data?.url?.replace(/\d{13}/g, "<ts>") }).map((x) => `upload: ${x}`));
console.log(respDiff.length ? respDiff.join("\n") : "identical");

console.log("\n== donation rows (old vs new)");
for (const k of ["gupshup", "flaxxa", "dccDown"]) {
  const d = diff(clean(results.baseline[k].row), clean(results.new[k].row));
  console.log(`${k}: ${d.length ? "\n  " + d.join("\n  ") : "identical"}`);
}

console.log("\n== outbound requests");
const logs = { baseline: readLog(envName, "baseline"), new: readLog(envName, "new") };
console.log("baseline", JSON.stringify(summarize(logs.baseline)));
console.log("new     ", JSON.stringify(summarize(logs.new)));
const cmp = compareLogs(logs.baseline, logs.new);
console.log(cmp.report);
for (const tag of ["baseline", "new"]) {
  const un = logs[tag].filter((e) => e.unmocked);
  check(un.length === 0, `${tag}: no unmocked outbound hosts${un.length ? ` (${[...new Set(un.map((e) => e.host))].join(", ")})` : ""}`);
  check(logs[tag].some((e) => e.service === "dcc"), `${tag}: DCC push recorded`);
  check(logs[tag].some((e) => e.service === "gupshup" || e.service === "flaxxa"), `${tag}: WhatsApp send recorded`);
  check(logs[tag].some((e) => e.service === "r2" && e.method === "PUT"), `${tag}: R2 PutObject recorded`);
}

await mongo.close();
await closeDb?.();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
