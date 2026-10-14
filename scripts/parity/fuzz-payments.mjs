#!/usr/bin/env node
// Differential fuzz of the payment routes with the outbound mocks on (the stock fuzz.mjs skips these routes).
//   MOCKS=1 scripts/parity/env.sh reset eq-payments; export SRC_MONGO_URI=... DATABASE_URL=...
//   node scripts/parity/fuzz-payments.mjs [envName] [basePort] [section]
// For every mutated request both servers must return the same status+body, store the same donation row, and at the end
// the outbound request logs must match.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import { sign, call as rawCall } from "./lib.mjs";
import { clearLog, readLog, compareLogs, setState, payOrder } from "./mocks/ctl.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envName = process.argv[2] || "eq-payments";
const base = Number(process.argv[3] || 9510);
const only = process.argv[4] || "";
const A = `http://localhost:${base}`;
const B = `http://localhost:${base + 1}`;
process.env.SRC_MONGO_URI ||= `mongodb://127.0.0.1:27018/m_${envName}`;
process.env.DATABASE_URL ||= `postgres://hkm@localhost:5433/pg_${envName}`;
const { donations: pgDon } = await import(pathToFileURL(`${ROOT}/src/db/tables.js`).href);
const { closeDb } = await import(pathToFileURL(`${ROOT}/src/db/pg.js`).href);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const mdb = mongo.db();
const adminUser = await mdb.collection("users").findOne({ role: "admin" });
const adminTok = sign({ userId: String(adminUser._id), role: "admin" });
const donor = await mdb.collection("donors").findOne({ mobile: { $regex: /^\d{10}$/ } }, { sort: { _id: -1 } });
let ipCounter = 0;
const call = (b, req) => rawCall(b, { ...req, headers: { "x-forwarded-for": `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`, ...req.headers } });
const hmac = (s, b) => crypto.createHmac("sha256", s).update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (v, key = "") => {
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== null && k !== "__v")
        .map((k) => [k, norm(v[k], k)])
    );
  if (typeof v === "string")
    return v
      .replace(/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g, "<id>")
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>")
      .replace(/receipt_\d+/g, "receipt_<ts>")
      .replace(/order_Mock\d+/g, "<order>");
  return v;
};
const canon = (v) => JSON.stringify(norm(v));

let total = 0;
let bad = 0;
const failures = [];
const rowOf = async (tag, id) => {
  if (!id || !/^[0-9a-f]{24}$/.test(String(id))) return null;
  if (tag === "baseline") return JSON.parse(JSON.stringify(await mdb.collection("donations").findOne({ _id: new ObjectId(id) })));
  return JSON.parse(JSON.stringify(await pgDon.findById(id, { lean: true })));
};
const VOLATILE = /^(createdAt|updatedAt|date|metaClientIp|donorRecordId|donorId|razorpayOrderId)$/;
const stripVolatile = (r) => (r ? Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k))) : r);

async function both(label, req, { row = false, wait = 0 } = {}) {
  total++;
  const a = await call(A, req);
  const b = await call(B, req);
  if (wait) await sleep(wait);
  const problems = [];
  if (a.status !== b.status) problems.push(`status ${a.status} != ${b.status}`);
  if (canon(a.data) !== canon(b.data)) problems.push(`body\n        A=${canon(a.data).slice(0, 300)}\n        B=${canon(b.data).slice(0, 300)}`);
  if (row && a.data?.donationId && b.data?.donationId) {
    const ra = canon(stripVolatile(await rowOf("baseline", a.data.donationId)));
    const rb = canon(stripVolatile(await rowOf("new", b.data.donationId)));
    if (ra !== rb) problems.push(`row\n        A=${ra.slice(0, 400)}\n        B=${rb.slice(0, 400)}`);
  }
  if (problems.length) {
    bad++;
    failures.push(`${label}: ${JSON.stringify(req.body ?? req.path).slice(0, 200)}\n      ${problems.join("\n      ")}`);
  }
  return { a, b };
}

const VALUES = [
  null, "", "  padded  ", 0, -1, 1, 12, 12345, 1.5, 100.555, 1e21, "12", "abc", "150", "12abc", true, false, "true", "yes", "0",
  [], ["a"], [150], {}, { a: 1 }, { _id: "x" }, { city: "Vizag", doorNo: 4, junk: 1 }, { city: { a: 1 } },
  "x".repeat(2000), "<script>alert(1)</script>", ".*(", "it's", 'a"b', "é日本", "6aaa64c9a669e4e9df6564b7", "abcdefghijkl",
  "2026-02-30", "\\", "%00",
];
const baseOrder = { name: "Fuzz", email: "fuzz@example.com", mobile: donor.mobile, amount: 501, sourcePage: "fuzz-page", sevaName: "Fuzz Seva" };
const ORDER_FIELDS = [
  "name", "donorName", "email", "donorEmail", "mobile", "donorMobile", "amount", "certificate", "panNumber", "mahaprasadam",
  "wantPrasadam", "prasadamAddress", "sourcePage", "sevakName", "sevaDate", "dob", "sevaName", "legacySevaId", "message", "type",
  "sevaSlug", "bannerImage", "festivalId", "festivalSlug", "campaignerSlug", "utm", "metaEventId", "metaFbp", "metaFbc", "account",
];

const section = (name) => !only || name.includes(only);

if (section("order")) {
  for (const f of ORDER_FIELDS) for (const v of VALUES) await both(`order.${f}`, { method: "POST", path: "/payments/order", body: { ...baseOrder, [f]: v } }, { row: true });
  for (const body of [undefined, [], "x", 5, null, { amount: "501" }, { amount: 501, utm: { source: 5, medium: [1] } }])
    await both("order body", { method: "POST", path: "/payments/order", body });
  await both("order bad json", { method: "POST", path: "/payments/order", body: "{" });
  for (const ua of ["x".repeat(500), ""]) await both("order ua", { method: "POST", path: "/payments/order", body: baseOrder, headers: { "user-agent": ua, "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }, { row: true });
}
if (section("subscription")) {
  for (const f of ORDER_FIELDS) for (const v of VALUES) await both(`sub.${f}`, { method: "POST", path: "/payments/subscription", body: { ...baseOrder, [f]: v } }, { row: true });
}
if (section("verify")) {
  const mk = async () => {
    const [x, y] = [await call(A, { method: "POST", path: "/payments/order", body: baseOrder }), await call(B, { method: "POST", path: "/payments/order", body: baseOrder })];
    return { x, y };
  };
  const { x, y } = await mk();
  for (const [tag, o] of [["baseline", x], ["new", y]]) payOrder(envName, tag, o.data.orderId, { id: "pay_fz" });
  const good = (o) => ({ razorpay_order_id: o.data.orderId, razorpay_payment_id: "pay_fz", razorpay_signature: hmac("local-razorpay-secret", `${o.data.orderId}|pay_fz`), donationId: o.data.donationId });
  for (const f of ["razorpay_order_id", "razorpay_payment_id", "razorpay_signature", "razorpay_subscription_id", "donationId"]) {
    for (const v of VALUES) {
      total++;
      const ra = await call(A, { method: "POST", path: "/payments/verify", body: { ...good(x), [f]: v } });
      const rb = await call(B, { method: "POST", path: "/payments/verify", body: { ...good(y), [f]: v } });
      if (ra.status !== rb.status || canon(ra.data) !== canon(rb.data)) {
        bad++;
        failures.push(`verify.${f}=${JSON.stringify(v).slice(0, 60)}: ${ra.status}/${rb.status}\n      A=${canon(ra.data).slice(0, 220)}\n      B=${canon(rb.data).slice(0, 220)}`);
      }
    }
  }
  await sleep(2000);
}
if (section("status")) {
  const { a, b } = await both("mk", { method: "POST", path: "/payments/order", body: baseOrder });
  for (const id of ["order_x", "", "%", "a b", "x".repeat(300), "😀", "..", "%00"])
    for (const q of ["", "?live=1", "?live=0", "?live=1&live=1", "?live[]=1"]) await both("status", { path: `/payments/status/${encodeURIComponent(id)}${q}` });
}
if (section("webhook")) {
  const o = (await call(A, { method: "POST", path: "/payments/order", body: baseOrder })).data;
  const o2 = (await call(B, { method: "POST", path: "/payments/order", body: baseOrder })).data;
  const evs = (ord) => [
    ["payment.captured", { payment: { entity: { id: "pay_w", order_id: ord.orderId, amount: 100 } } }],
    ["payment.failed", { payment: { entity: { id: "pay_wf", order_id: ord.orderId, error_code: "X", created_at: "zz" } } }],
    ["subscription.charged", { subscription: { entity: { id: "sub_none" } }, payment: { entity: { id: "pay_ws", amount: "12" } } }],
    ["subscription.activated", { subscription: { entity: { id: 5 } } }],
    ["subscription.cancelled", { subscription: { entity: { id: { a: 1 } } } }],
    ["subscription.completed", { subscription: { entity: {} } }],
    ["payment.downtime.started", { payment: { downtime: { entity: { id: "dt_fz", method: 5, begin: "bad", instrument: [1] } } } }],
    ["payment.downtime.resolved", { payment: { downtime: { entity: { id: "dt_fz", begin: 1790000000.5 } } } }],
    ["unknown.event", {}],
    [null, null],
    ["payment.captured", null],
    ["payment.captured", { payment: null }],
  ];
  const send = async (server, tag, ord, [name, payload], acct) => {
    const body = JSON.stringify({ event: name, payload });
    const secrets = { "/payments/webhook": "local-webhook-secret", "/payments/webhook/donations": "local-webhook-secret", "/payments/webhook/touchstone": "local-touchstone-webhook", "/payments/webhook/shop": "local-webhook-secret" };
    return call(server, { method: "POST", path: acct, body, headers: { "content-type": "application/json", "x-razorpay-signature": hmac(secrets[acct], body) } });
  };
  for (const acct of ["/payments/webhook", "/payments/webhook/donations", "/payments/webhook/touchstone", "/payments/webhook/shop"]) {
    const ea = evs(o);
    const eb = evs(o2);
    for (let i = 0; i < ea.length; i++) {
      total++;
      const ra = await send(A, "baseline", o, ea[i], acct);
      const rb = await send(B, "new", o2, eb[i], acct);
      await sleep(600);
      if (ra.status !== rb.status || canon(ra.data) !== canon(rb.data)) {
        bad++;
        failures.push(`webhook ${acct} ${ea[i][0]}: ${ra.status}/${rb.status}`);
      }
    }
  }
  for (const [label, body, headers] of [
    ["not json signed", "not json", true],
    ["empty signed", "", true],
    ["array signed", "[]", true],
    ["no content-type", "{}", true],
  ]) {
    total++;
    const mk = (server) => call(server, { method: "POST", path: "/payments/webhook", body, headers: { "x-razorpay-signature": hmac("local-webhook-secret", body), ...(label === "no content-type" ? {} : { "content-type": "application/json" }) } });
    const ra = await mk(A);
    const rb = await mk(B);
    if (ra.status !== rb.status || canon(ra.data) !== canon(rb.data)) {
      bad++;
      failures.push(`webhook ${label}: ${ra.status}/${rb.status} ${canon(ra.data).slice(0, 100)} | ${canon(rb.data).slice(0, 100)}`);
    }
  }
  await sleep(1500);
  const cnt = async () => [await mdb.collection("donations").countDocuments(), (await pgDon.count({}))];
  const [ma, pb] = await cnt();
  console.log(`donation rows after webhook fuzz: mongo ${ma} pg ${pb} (diff vs pristine should match)`);
}
if (section("admin")) {
  const adm = (label, p, m = "GET", body) => both(label, { method: m, path: p, token: adminTok, body });
  for (const id of ["abc", "000000000000000000000000", "zz".repeat(12), "%", "6acf6c7acefdec68381023ee", "abcdefghijkl"]) await adm("reconcile", `/payments/reconcile/${encodeURIComponent(id)}`, "POST");
  for (const q of ["", "?account=donations", "?account=nope", "?deep=true", "?deep=1", "?account[]=x", "?account=constructor", "?account=__proto__"]) {
    await adm("audit" + q, `/payments/audit-subscriptions${q}`);
    await adm("backfill" + q, `/payments/backfill-subscription-gaps${q}`, "POST");
  }
  for (const q of ["", "?hours=0", "?hours=-1", "?hours=abc", "?hours=1e300", "?hours=2e9", "?limit=0", "?limit=-2", "?limit=1.5", "?limit=abc", "?limit=1e400", "?delayMs=abc", "?send=true&hours=0&limit=0&delayMs=0", "?send=false", "?hours=1&hours=2", "?secret=local-internal-secret"]) {
    for (const m of ["GET", "POST"]) {
      total++;
      const req = { method: m, path: `/api/internal/resend-receipts${q}`, headers: q.includes("secret=") ? {} : { "x-internal-secret": "local-internal-secret" } };
      const a = await call(A, req);
      const b = await call(B, req);
      if (a.status !== b.status || canon(a.data) !== canon(b.data)) {
        bad++;
        failures.push(`resend ${m} ${q}: ${a.status}/${b.status}\n      A=${canon(a.data).slice(0, 250)}\n      B=${canon(b.data).slice(0, 250)}`);
      }
    }
  }
  for (const [h, v] of [["x-internal-secret", "wrong"], ["x-internal-secret", ""], ["x-other", "1"]]) {
    for (const p of ["/api/internal/send-pending-reminders", "/api/internal/resend-receipts"]) await both("internal auth", { path: p, headers: { [h]: v } });
  }
  for (const m of ["GET", "POST", "PUT"]) for (const p of ["/webhooks/whatsapp/gupshup/local-gupshup-secret", "/webhooks/whatsapp/gupshup/x", "/webhooks/whatsapp/gupshup"]) await both(`gupshup ${m}`, { method: m, path: p, body: m === "GET" ? undefined : { type: "message-event", payload: { id: "zz", type: "sent" } } });
  for (const body of [undefined, [], "x", null, { type: "message-event" }, { type: "message-event", payload: { id: 5, type: "sent" } }, { type: "message-event", payload: { id: {}, gsId: "q", type: ["sent"] } }, [{ type: "message-event", payload: { id: "a", type: "read" } }, 5, null]])
    await both("gupshup body", { method: "POST", path: "/webhooks/whatsapp/gupshup/local-gupshup-secret", body });
}

await sleep(2500);
const cmp = compareLogs(readLog(envName, "baseline"), readLog(envName, "new"));
console.log(`\n${total} requests, ${bad} response/row differences; outbound ${cmp.equal ? "identical" : "DIFFERENT"}`);
if (!cmp.equal) console.log(cmp.report.split("\n").slice(0, 25).map((x) => x.slice(0, 300)).join("\n"));
for (const f of failures.slice(0, 60)) console.log("  - " + f);
if (failures.length > 60) console.log(`  ... ${failures.length - 60} more`);
await mongo.close();
await closeDb();
process.exit(bad || !cmp.equal ? 1 : 0);
