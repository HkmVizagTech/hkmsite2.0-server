#!/usr/bin/env node
// Full payment flows old vs new with the outbound-service mocks.
//   MOCKS=1 scripts/parity/env.sh reset eq-payments   (touchstone keys appended to env files by hand, see report)
//   export SRC_MONGO_URI=... DATABASE_URL=...
//   node scripts/parity/writes-payments-flows.mjs [envName=eq-payments] [basePort=9510] [scenarioSubstring]
// Each scenario runs on the baseline then the new server; HTTP transcripts, donation rows and the exact outbound
// requests to the fakes are compared.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import { sign, call } from "./lib.mjs";
import {
  setState,
  resetMocks,
  clearLog,
  readLog,
  payOrder,
  signWebhook,
  compareLogs,
  fieldDiff,
} from "./mocks/ctl.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envName = process.argv[2] || "eq-payments";
const base = Number(process.argv[3] || 9510);
const only = process.argv[4] || "";
const SERVERS = [
  { tag: "baseline", url: `http://localhost:${base}` },
  { tag: "new", url: `http://localhost:${base + 1}` },
];
process.env.SRC_MONGO_URI ||= `mongodb://127.0.0.1:27018/m_${envName}`;
process.env.DATABASE_URL ||= `postgres://hkm@localhost:5433/pg_${envName}`;
const { donations: pgDon } = await import(pathToFileURL(`${ROOT}/src/db/tables.js`).href);
const { query: pq, closeDb } = await import(pathToFileURL(`${ROOT}/src/db/pg.js`).href);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const mdb = mongo.db();
const mDon = mdb.collection("donations");

const SECRETS = {
  default: ["local-razorpay-secret", "local-webhook-secret", "/payments/webhook"],
  donations: ["local-razorpay-secret", "local-webhook-secret", "/payments/webhook/donations"],
  touchstone: ["local-touchstone-secret", "local-touchstone-webhook", "/payments/webhook/touchstone"],
  shop: ["local-razorpay-secret", "local-webhook-secret", "/payments/webhook/shop"],
};
const hmac = (s, b) => crypto.createHmac("sha256", s).update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adminUser = await mdb.collection("users").findOne({ role: "admin" });
const adminTok = sign({ userId: String(adminUser._id), role: "admin" });
const donorWithMobile = await mdb
  .collection("donors")
  .findOne({ mobile: { $regex: /^\d{10}$/ } }, { sort: { _id: -1 } });
const donorTok = sign({ donorId: String(donorWithMobile._id), type: "donor" });

let failures = 0;
const report = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
};

const rowOf = async (S, id) => {
  if (!id) return null;
  if (S.tag === "baseline") return JSON.parse(JSON.stringify(await mDon.findOne({ _id: new ObjectId(id) })));
  return JSON.parse(JSON.stringify(await pgDon.findById(id, { lean: true })));
};
const rowsBySub = async (S, subId) => {
  if (S.tag === "baseline") {
    const r = await mDon.find({ subscriptionId: subId }).sort({ createdAt: 1, _id: 1 }).toArray();
    return JSON.parse(JSON.stringify(r));
  }
  return JSON.parse(
    JSON.stringify(await pgDon.find({ subscriptionId: subId }, { sort: { createdAt: 1, _id: 1 }, lean: true }))
  );
};

const quiesce = async () => {
  let last = -1;
  let stableSince = Date.now();
  const start = Date.now();
  for (;;) {
    const n = SERVERS.reduce((a, S) => a + readLog(envName, S.tag).length, 0);
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 1500) return;
    if (Date.now() - start > 45000) return;
    await sleep(200);
  }
};

const TS_KEYS =
  /^(updatedAt|receiptGeneratedAt|dccSyncedAt|dccLastAttemptAt|whatsappReceiptSentAt|whatsappThankYouSentAt|lastPaymentDate|lastReconcileCheckAt|closedAsNotPaidAt|whatsappDeliveredAt|metaPurchaseSentAt|dccRecoveredAt|date|createdAt|at|since|autoSince|from|to|receivedAt|begin|end)$/;
const ctx = (keep) => {
  const ids = new Map();
  const idStr = (s) =>
    s.replace(/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g, (m) =>
      ids.has(m) ? ids.get(m) : (ids.set(m, `<id${ids.size + 1}>`), ids.get(m))
    );
  const walk = (v, key = "") => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => k !== "__v" && v[k] !== null)
          .map((k) => [k, walk(v[k], k)])
      );
    if (typeof v === "string") {
      if (TS_KEYS.test(key) && !keep.includes(key) && /^\d{4}-\d\d-\d\dT/.test(v)) return "<ts>";
      return idStr(v)
        .replace(/receipt_\d+/g, "receipt_<ts>")
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (m) => (keep.includes("*") ? m : "<ts>"));
    }
    return v;
  };
  return walk;
};

const pgDowntime = (x) => ({
  downtimeId: x.downtime_id,
  event: x.event,
  method: x.method,
  instrument: x.instrument,
  severity: x.severity,
  status: x.status,
  begin: x.begin_at ?? x.begin,
  end: x.end_at ?? x.end,
});
const results = [];
async function scenario(name, fn, { keep = [], ignoreOutbound = false } = {}) {
  if (only && !name.includes(only)) return;
  const transcripts = {};
  for (const S of SERVERS) {
    clearLog(envName, S.tag);
    setState(envName, S.tag, {
      razorpay: null,
      dcc: null,
      flaxxa: null,
      gupshup: null,
      meta: null,
      drm: null,
      r2: null,
    });
    const t = [];
    S.t = t;
    S.step = async (label, req) => {
      const r = await call(S.url, req);
      t.push({ label, status: r.status, body: r.data });
      if (/^\/(payments\/webhook|webhooks)/.test(req.path)) await sleep(900);
      return r;
    };
    S.snap = async (label, id) => t.push({ label: `row:${label}`, row: await rowOf(S, id) });
    try {
      await fn(S, t);
      await quiesce();
    } catch (e) {
      t.push({ label: "SCENARIO ERROR", error: String(e && e.stack ? e.stack : e).slice(0, 400) });
    }
    transcripts[S.tag] = t;
  }
  const w = {};
  for (const S of SERVERS) w[S.tag] = ctx(keep);
  const a = w.baseline(transcripts.baseline);
  const b = w.new(transcripts.new);
  const d = fieldDiff(a, b);
  const mask = (entries) =>
    entries.map((e) => {
      const c = JSON.parse(JSON.stringify(e));
      if (c.body?.bytes !== undefined) delete c.body.bytes;
      for (const f of c.body?.multipart?.files || []) delete f.size;
      return c;
    });
  const logs = { baseline: mask(readLog(envName, "baseline")), new: mask(readLog(envName, "new")) };
  const cmp = compareLogs(logs.baseline, logs.new);
  const unm = [...logs.baseline, ...logs.new].filter((e) => e.unmocked);
  const ok = d.length === 0 && (ignoreOutbound || cmp.equal) && unm.length === 0;
  report(ok, `${name} (http/rows ${a.length} steps, outbound ${logs.baseline.length}/${logs.new.length})`);
  if (d.length) console.log("    transcript diff:\n      " + d.slice(0, 10).map((x) => x.slice(0, 260)).join("\n      "));
  if (!cmp.equal && !ignoreOutbound) console.log("    " + cmp.report.split("\n").slice(0, 14).map((x) => x.slice(0, 260)).join("\n    "));
  if (unm.length) console.log("    unmocked:", [...new Set(unm.map((e) => e.host + e.path))].join(", "));
  if (process.env.VERBOSE) console.log("    " + transcripts.baseline.filter((x) => x.status).map((x) => `${x.label}:${x.status}`).join(" | "));
  results.push({ name, ok });
}

const orderBody = (extra = {}) => ({
  name: "Flow Donor",
  email: "flow@example.com",
  mobile: donorWithMobile.mobile,
  amount: 501,
  sourcePage: "seva-page",
  sevaName: "Flow Seva",
  ...extra,
});
const paidWebhook = (S, account, orderId, payId, extra = {}) => {
  const [, whSecret, hook] = SECRETS[account];
  const body = JSON.stringify({
    entity: "event",
    event: "payment.captured",
    payload: {
      payment: { entity: { id: payId, order_id: orderId, amount: 50100, status: "captured", method: "upi", ...extra } },
    },
  });
  return {
    method: "POST",
    path: hook,
    body,
    headers: { "content-type": "application/json", "x-razorpay-signature": hmac(whSecret, body) },
  };
};
const event = (account, name, payload) => {
  const [, whSecret, hook] = SECRETS[account];
  const body = JSON.stringify({ entity: "event", event: name, payload });
  return {
    method: "POST",
    path: hook,
    body,
    headers: { "content-type": "application/json", "x-razorpay-signature": hmac(whSecret, body) },
  };
};
const verifyBody = (account, orderId, payId, donationId) => ({
  razorpay_order_id: orderId,
  razorpay_payment_id: payId,
  razorpay_signature: hmac(SECRETS[account][0], `${orderId}|${payId}`),
  ...(donationId ? { donationId } : {}),
});

// ---------------------------------------------------------------------------------------------------------------
for (const account of ["default", "donations", "touchstone", "shop"]) {
  await scenario(`one-time ${account}: order -> status -> verify -> pipeline -> duplicate webhook`, async (S) => {
    const o = await S.step("order", {
      method: "POST",
      path: "/payments/order",
      body: orderBody({ account, utm: { source: "fb" }, metaEventId: "ev1", metaFbp: "fbp", festivalSlug: "no-such" }),
    });
    const orderId = o.data?.orderId;
    const donationId = o.data?.donationId;
    await S.snap("created", donationId);
    await S.step("status unpaid", { path: `/payments/status/${orderId}` });
    await S.step("status live unpaid", { path: `/payments/status/${orderId}?live=1` });
    if (!orderId) return;
    payOrder(envName, S.tag, orderId, { id: "pay_flow_" + account });
    await S.step("status live paid", { path: `/payments/status/${orderId}?live=1` });
    await sleep(1500);
    await S.snap("after live", donationId);
    await S.step("webhook dup", paidWebhook(S, account, orderId, "pay_flow_" + account));
    await sleep(1000);
    await S.snap("after webhook", donationId);
    await S.step("verify after", {
      method: "POST",
      path: "/payments/verify",
      body: verifyBody(account, orderId, "pay_flow_" + account, donationId),
    });
    await S.step("status done", { path: `/payments/status/${orderId}` });
  });
}

await scenario("one-time verify path (browser) + webhook later", async (S) => {
  const o = await S.step("order", {
    method: "POST",
    path: "/payments/order",
    body: orderBody({
      sourcePage: "donations",
      certificate: true,
      mahaprasadam: "yes",
      prasadamAddress: { doorNo: 4, city: "Vizag", pincode: "530001" },
      dob: "1990-01-01",
      panNumber: "ABCDE1234F",
      campaignerSlug: "none",
    }),
  });
  const { orderId, donationId } = o.data || {};
  payOrder(envName, S.tag, orderId, { id: "pay_v1" });
  await S.step("verify bad sig", {
    method: "POST",
    path: "/payments/verify",
    body: { ...verifyBody("default", orderId, "pay_v1"), razorpay_signature: "x".repeat(64) },
  });
  await S.step("verify missing", { method: "POST", path: "/payments/verify", body: { razorpay_order_id: orderId } });
  await S.step("verify unknown", {
    method: "POST",
    path: "/payments/verify",
    body: verifyBody("default", "order_nope", "pay_v1"),
  });
  await S.step("verify bad donation id", {
    method: "POST",
    path: "/payments/verify",
    body: verifyBody("default", orderId, "pay_v1", "abc"),
  });
  await S.step("verify ok", {
    method: "POST",
    path: "/payments/verify",
    body: verifyBody("default", orderId, "pay_v1", donationId),
  });
  await sleep(1500);
  await S.snap("after verify", donationId);
  await S.step("webhook later", paidWebhook(S, "default", orderId, "pay_v1"));
  await sleep(800);
  await S.snap("after webhook", donationId);
});

await scenario("createOrder validation + wrong types", async (S) => {
  for (const [label, body] of Object.entries({
    below: { amount: 50 },
    noamount: { amount: undefined },
    strAmount: { amount: "250" },
    arrAmount: { amount: [250] },
    badCert: { certificate: "abc" },
    emptyCert: { certificate: "" },
    badFest: { festivalId: "zzz" },
    objName: { name: { a: 1 } },
    addrString: { prasadamAddress: "12 Main St" },
    addrBadCity: { prasadamAddress: { city: { a: 1 } } },
    legacyBad: { legacySevaId: "x" },
    fractional: { amount: 100.5 },
    utmArr: { utm: ["a"] },
    festSlugObj: { festivalSlug: { $ne: null } },
    acctUnknown: { account: "zzz" },
  })) {
    const r = await S.step(label, { method: "POST", path: "/payments/order", body: orderBody(body) });
    if (r.data?.donationId) await S.snap(label, r.data.donationId);
  }
  await S.step("bad json", { method: "POST", path: "/payments/order", body: "{bad", headers: {} });
});

await scenario("razorpay error on createOrder", async (S) => {
  setState(envName, S.tag, {
    razorpay: { failNext: 1, status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "scripted" } } },
  });
  await S.step("order fails", { method: "POST", path: "/payments/order", body: orderBody() });
  await S.step("order ok", { method: "POST", path: "/payments/order", body: orderBody() });
});

await scenario("failed payment webhook paths", async (S) => {
  const mk = async (label) =>
    (
      await S.step(`order ${label}`, {
        method: "POST",
        path: "/payments/order",
        body: orderBody({ sourcePage: "p-" + label }),
      })
    ).data || {};
  const a = await mk("a");
  const failed = (orderId, id) =>
    event("default", "payment.failed", {
      payment: {
        entity: {
          id,
          order_id: orderId,
          status: "failed",
          method: "upi",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "declined",
          error_source: "bank",
          error_step: "payment_authorization",
          error_reason: "insufficient_funds",
          upi: { flow: "collect" },
          created_at: 1790000000,
        },
      },
    });
  await S.step("failed (no captured)", failed(a.orderId, "pay_f1"));
  await sleep(800);
  await S.snap("a", a.donationId);
  await S.step("failed again same id", failed(a.orderId, "pay_f1"));
  await S.step("failed other id", failed(a.orderId, "pay_f2"));
  await sleep(800);
  await S.snap("a2", a.donationId);
  const b = await mk("b");
  payOrder(envName, S.tag, b.orderId, { id: "pay_b_ok" });
  await S.step("failed but captured", failed(b.orderId, "pay_b_fail"));
  await sleep(1500);
  await S.snap("b", b.donationId);
  const c = await mk("c");
  setState(envName, S.tag, { razorpay: { failNext: 1, status: 500, body: { error: { description: "boom" } } } });
  await S.step("failed razorpay down", failed(c.orderId, "pay_c_fail"));
  await sleep(800);
  await S.snap("c", c.donationId);
  await S.step("failed unknown order", failed("order_unknown", "pay_x"));
  await S.step("failed no order", event("default", "payment.failed", { payment: { entity: { id: "p" } } }));
  await S.step(
    "captured no order",
    event("default", "payment.captured", { payment: { entity: { id: "p", amount: 100 } } })
  );
  await S.step("captured unknown order", paidWebhook(S, "default", "order_unknown", "pay_zz"));
  for (const [i, n] of [
    "payment.downtime.started",
    "payment.downtime.updated",
    "payment.downtime.resolved",
  ].entries()) {
    await S.step(
      n,
      event("default", n, {
        payment: {
          downtime: {
            entity: {
              id: "dt_flow",
              method: "upi",
              instrument: { psp: "google_pay" },
              severity: "high",
              status: n.split(".").pop(),
              begin: 1790000000 + i,
              end: 1790009999,
            },
          },
        },
      })
    );
  }
  await S.step("unhandled", event("default", "refund.created", {}));
  await S.step("bad sig", {
    method: "POST",
    path: "/payments/webhook",
    body: "{}",
    headers: { "content-type": "application/json", "x-razorpay-signature": "0".repeat(64) },
  });
  await S.step("no sig", {
    method: "POST",
    path: "/payments/webhook",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  const dt = await (S.tag === "baseline"
    ? mdb.collection("paymentdowntimes").find({ downtimeId: "dt_flow" }).toArray()
    : pq("select * from payment_downtimes where downtime_id='dt_flow' order by id").then((r) =>
        r.rows.map((x) => pgDowntime(x))
      ));
  S.t.push({ label: "downtimes", rows: JSON.parse(JSON.stringify(dt)).map(({ _id, receivedAt, ...rest }) => rest) });
});

await scenario("subscription: create -> verify -> charged x3 -> activated -> cancelled/completed", async (S) => {
  const s = await S.step("subscription", {
    method: "POST",
    path: "/payments/subscription",
    body: orderBody({ amount: 1001, sevaName: "Monthly Flow", sourcePage: "monthly", certificate: "true" }),
  });
  const { subscriptionId, donationId } = s.data || {};
  await S.step("subscription again (plan reuse)", {
    method: "POST",
    path: "/payments/subscription",
    body: orderBody({ amount: 1001, sevaName: "Monthly Flow" }),
  });
  await S.step("subscription other acct", {
    method: "POST",
    path: "/payments/subscription",
    body: orderBody({ amount: 1001, account: "donations" }),
  });
  await S.step("sub below min", { method: "POST", path: "/payments/subscription", body: { amount: 10 } });
  await S.snap("created", donationId);
  const sig = hmac(SECRETS.default[0], `pay_s1|${subscriptionId}`);
  await S.step("verify sub bad sig", {
    method: "POST",
    path: "/payments/verify",
    body: { razorpay_payment_id: "pay_s1", razorpay_subscription_id: subscriptionId, razorpay_signature: "x" },
  });
  await S.step("verify sub", {
    method: "POST",
    path: "/payments/verify",
    body: {
      razorpay_payment_id: "pay_s1",
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: sig,
      donationId,
    },
  });
  await sleep(1500);
  const hookStep = async (label, req) => {
    const r = await S.step(label, req);
    await sleep(900);
    return r;
  };
  const charged = (n, amount = 100100) =>
    event("default", "subscription.charged", {
      subscription: { entity: { id: subscriptionId } },
      payment: { entity: { id: `pay_s${n}`, amount, status: "captured", subscription_id: subscriptionId } },
    });
  await hookStep("charged #1 dup of verify", charged(1));
  await hookStep("charged #2", charged(2));
  await sleep(2000);
  await hookStep("charged #2 dup", charged(2));
  await hookStep("charged #3 other amount", charged(3, 120000));
  await sleep(2000);
  await S.step(
    "charged no sub",
    event("default", "subscription.charged", { payment: { entity: { id: "pay_zz", amount: 100 } } })
  );
  await S.step(
    "charged unknown sub",
    event("default", "subscription.charged", {
      subscription: { entity: { id: "sub_none" } },
      payment: { entity: { id: "pay_zy", amount: 100 } },
    })
  );
  await S.step(
    "activated",
    event("default", "subscription.activated", { subscription: { entity: { id: subscriptionId } } })
  );
  await S.step(
    "completed",
    event("default", "subscription.completed", { subscription: { entity: { id: subscriptionId } } })
  );
  await S.step(
    "cancelled",
    event("default", "subscription.cancelled", { subscription: { entity: { id: subscriptionId } } })
  );
  await sleep(1000);
  S.t.push({ label: "rows", rows: await rowsBySub(S, subscriptionId) });
});

await scenario("subscription: first charge via webhook only; cancelled while pending", async (S) => {
  const s = await S.step("subscription", {
    method: "POST",
    path: "/payments/subscription",
    body: orderBody({ amount: 2002 }),
  });
  const { subscriptionId, donationId } = s.data || {};
  await S.step(
    "charged first",
    event("default", "subscription.charged", {
      subscription: { entity: { id: subscriptionId } },
      payment: { entity: { id: "pay_t1", amount: 200200 } },
    })
  );
  await sleep(2500);
  await S.snap("after first", donationId);
  const s2 = await S.step("subscription 2", {
    method: "POST",
    path: "/payments/subscription",
    body: orderBody({ amount: 2002 }),
  });
  await S.step(
    "cancel pending",
    event("default", "subscription.cancelled", { subscription: { entity: { id: s2.data?.subscriptionId } } })
  );
  await S.snap("cancelled", s2.data?.donationId);
  await S.step("activated no id", event("default", "subscription.activated", { subscription: { entity: {} } }));
});

await scenario("DCC down then sweep + resend-receipts + admin reconcile", async (S) => {
  setState(envName, S.tag, { dcc: { failNext: 1, status: 500, body: { Message: "DCC scripted outage" } } });
  const o = await S.step("order", {
    method: "POST",
    path: "/payments/order",
    body: orderBody({ sourcePage: "donations" }),
  });
  payOrder(envName, S.tag, o.data.orderId, { id: "pay_d1" });
  await S.step("webhook", paidWebhook(S, "default", o.data.orderId, "pay_d1"));
  await sleep(2500);
  await S.snap("dcc failed", o.data.donationId);
  await S.step("resend dry", {
    path: "/api/internal/resend-receipts?hours=0",
    headers: { "x-internal-secret": "local-internal-secret" },
  });
  await S.step("resend bad secret", {
    path: "/api/internal/resend-receipts",
    headers: { "x-internal-secret": "nope" },
  });
  for (const q of ["limit=abc", "hours=0&limit=0", "hours=0&limit=-1", "hours=1e300", "hours=2e9&limit=1"])
    await S.step("resend " + q, {
      path: `/api/internal/resend-receipts?${q}`,
      headers: { "x-internal-secret": "local-internal-secret" },
    });
  const adm = (l, p, m = "GET", body) => S.step(l, { method: m, path: p, token: adminTok, body });
  const id = o.data.donationId;
  await adm("dcc status", "/donations/dcc-status");
  await adm("dcc status includeOld", "/donations-admin/dcc-status?includeOld=true");
  await adm("needs manual receipt", "/donations/needs-manual-receipt");
  await adm("whatsapp audit", "/donations/whatsapp-audit");
  await adm("needs whatsapp", "/donations/needs-whatsapp");
  await adm("receipt-number bad", `/donations/${id}/receipt-number`, "PUT", { receiptNumber: "  " });
  await adm("push one bad id", "/donations-admin/transactions/abc/dcc-push", "POST");
  await adm("push one", `/donations-admin/transactions/${id}/dcc-push`, "POST");
  await sleep(1500);
  await S.snap("after push one", id);
  await adm("resend whatsapp", `/donations/${id}/resend-whatsapp`, "POST");
  await adm("resend receipt", `/donations/${id}/resend-receipt`, "POST");
  await adm("resend recent whatsapp", "/donations/resend-recent-whatsapp", "POST", { hours: 0, limit: 5, dryRun: false });
  const o2 = await S.step("order2", { method: "POST", path: "/payments/order", body: orderBody({ sourcePage: "donations" }) });
  payOrder(envName, S.tag, o2.data.orderId, { id: "pay_d2" });
  setState(envName, S.tag, { dcc: { failNext: 1, status: 500, body: { Message: "DCC scripted outage" } } });
  await S.step("webhook2", paidWebhook(S, "default", o2.data.orderId, "pay_d2"));
  await sleep(2500);
  await adm("dcc push all", "/donations/dcc-push-all", "POST");
  await sleep(3000);
  await S.snap("after push all", o2.data.donationId);
  await adm("set receipt number", `/donations/${o2.data.donationId}/receipt-number`, "PUT", { receiptNumber: "HKMI|MANUAL|1" });
  await adm("reconcile-pending admin", "/donations-admin/reconcile-pending", "POST", { fix: true });
  await S.snap("final", o.data.donationId);
});

await scenario(
  "reconcile endpoint + audit-pending",
  async (S) => {
    const mk = async (l, sp) =>
      (await S.step(`order ${l}`, { method: "POST", path: "/payments/order", body: orderBody({ sourcePage: sp }) }))
        .data || {};
    const a = await mk("a", "seva-page");
    const b = await mk("b", "seva-page");
    const c = await mk("c", "seva-page");
    payOrder(envName, S.tag, a.orderId, { id: "pay_ra" });
    payOrder(envName, S.tag, b.orderId, { id: "pay_rb", status: "failed" });
    payOrder(envName, S.tag, c.orderId, { id: "pay_rc", status: "authorized", amount: 50100 });
    const adm = (l, p, m = "POST") => S.step(l, { method: m, path: p, token: adminTok });
    await adm("reconcile a", `/payments/reconcile/${a.donationId}`);
    await sleep(1500);
    await S.snap("a", a.donationId);
    await adm("reconcile a again", `/payments/reconcile/${a.donationId}`);
    await adm("reconcile b", `/payments/reconcile/${b.donationId}`);
    await adm("reconcile bad id", "/payments/reconcile/abc");
    await adm("reconcile unknown", `/payments/reconcile/${"1".repeat(24)}`);
    await S.step("reconcile no auth", { method: "POST", path: `/payments/reconcile/${a.donationId}` });
    await adm("audit-pending preview", "/donations/audit-pending?scope=all&limit=200", "GET");
    await adm("audit-pending fix", "/donations/audit-pending?scope=all&limit=200&fix=true", "GET");
    await sleep(3000);
    for (const [l, d] of [
      ["b", b],
      ["c", c],
    ])
      await S.snap(l, d.donationId);
    setState(envName, S.tag, { razorpay: { captureFail: { status: 400, description: "cannot capture" } } });
    const d = await mk("d", "seva-page");
    payOrder(envName, S.tag, d.orderId, { id: "pay_rd", status: "authorized", amount: 50100 });
    await adm("audit capture fails", "/donations/audit-pending?scope=all&limit=500&fix=true", "GET");
    await sleep(1500);
    await S.snap("d", d.donationId);
  },
  { ignoreOutbound: false }
);

await scenario(
  "audit-subscriptions + backfill-subscription-gaps",
  async (S) => {
    const s = await S.step("subscription", {
      method: "POST",
      path: "/payments/subscription",
      body: orderBody({ amount: 3003, sevaName: "Audit Seva" }),
    });
    const subId = s.data?.subscriptionId;
    setState(envName, S.tag, {
      razorpay: {
        subscriptions: {
          [subId]: {
            status: "active",
            paid_count: 2,
            plan_id: "plan_x",
            total_count: 120,
            created_at: 1790000000,
            current_end: 1792000000,
            notes: { a: "b" },
          },
        },
        invoices: {
          [subId]: [
            {
              id: "inv_1",
              status: "paid",
              payment_id: "pay_inv1",
              amount: 300300,
              date: 1790000100,
              customer_details: { name: "A", email: "audit.person@example.com", contact: "+919876543210" },
            },
            {
              id: "inv_2",
              status: "paid",
              payment_id: "pay_inv2",
              amount: 300300,
              date: 1790100100,
              customer_details: { email: null },
            },
            { id: "inv_3", status: "issued", payment_id: null, amount: 300300, date: 1790200100 },
          ],
        },
      },
    });
    const adm = (l, p, m = "GET") => S.step(l, { method: m, path: p, token: adminTok });
    await adm("audit", "/payments/audit-subscriptions");
    await adm("audit deep", "/payments/audit-subscriptions?deep=true&account=donations");
    await adm("audit touchstone", "/payments/audit-subscriptions?account=touchstone");
    await adm("backfill preview", "/payments/backfill-subscription-gaps", "POST");
    await adm("backfill execute", "/payments/backfill-subscription-gaps?execute=true", "POST");
    await sleep(3000);
    await adm("backfill again", "/payments/backfill-subscription-gaps?execute=true", "POST");
    S.t.push({ label: "rows", rows: await rowsBySub(S, subId) });
    await S.step("no auth", { path: "/payments/audit-subscriptions" });
  },
  { keep: ["createdAt"] }
);

await scenario("whatsapp 401 / meta / drm failures", async (S) => {
  setState(envName, S.tag, {
    gupshup: { failNext: 1, status: 401, body: { status: "error", message: "Authentication failed" } },
    meta: { failNext: 1, status: 400 },
    drm: { failNext: 1, status: 500 },
  });
  const o = await S.step("order", { method: "POST", path: "/payments/order", body: orderBody() });
  payOrder(envName, S.tag, o.data.orderId, { id: "pay_w1" });
  await S.step("webhook", paidWebhook(S, "default", o.data.orderId, "pay_w1"));
  await sleep(2500);
  await S.snap("after 401", o.data.donationId);
  await S.step("resend", {
    path: "/api/internal/resend-receipts?hours=0&send=true&delayMs=0",
    headers: { "x-internal-secret": "local-internal-secret" },
  });
  await sleep(1500);
  await S.snap("after resend", o.data.donationId);
  const gs = { method: "POST", path: "/webhooks/whatsapp/gupshup/local-gupshup-secret" };
  const id = (await rowOf(S, o.data.donationId))?.whatsappMessageId;
  const ev = (type, payload) => ({ ...gs, body: { type: "message-event", payload: { id, type, payload } } });
  for (const t of ["sent", "delivered", "sent", "read"]) await S.step("gs " + t, ev(t));
  await S.snap("delivered", o.data.donationId);
  await S.step("gs failed", ev("failed", { code: 131026, reason: "undeliverable" }));
  await S.step("gs delivered after failed", ev("delivered"));
  await S.snap("after gs", o.data.donationId);
  await S.step("gs unknown", { ...gs, body: { type: "message-event", payload: { id: "nope", type: "sent" } } });
  await S.step("gs incomplete", { ...gs, body: { type: "message-event", payload: {} } });
  await S.step("gs inbound", { ...gs, body: { type: "message", payload: { sender: { phone: "1" } } } });
  await S.step("gs array", { ...gs, body: [ev("read").body] });
  await S.step("gs bad secret", { method: "POST", path: "/webhooks/whatsapp/gupshup/wrong", body: {} });
});

await scenario(
  "pending reminders (flaxxa + endpoint) and stale close",
  async (S) => {
    const o = await S.step("order", {
      method: "POST",
      path: "/payments/order",
      body: orderBody({ sourcePage: "janmashtami", sevaSlug: "abhisheka" }),
    });
    const o2 = await S.step("order2", {
      method: "POST",
      path: "/payments/order",
      body: orderBody({ sourcePage: "janmashtami", mobile: "", donorMobile: undefined }),
    });
    const ago = new Date(Date.now() - 20 * 60 * 1000);
    for (const S2 of [S]) {
      for (const id of [o.data.donationId, o2.data.donationId]) {
        if (S.tag === "baseline") await mDon.updateOne({ _id: new ObjectId(id) }, { $set: { createdAt: ago } });
        else await pq("update donations set created_at=$2 where id=$1", [id, ago]);
      }
    }
    await S.step("reminders no secret", { path: "/api/internal/send-pending-reminders" });
    await S.step("reminders", {
      path: "/api/internal/send-pending-reminders",
      headers: { "x-internal-secret": "local-internal-secret" },
    });
    await sleep(1500);
    await S.snap("o", o.data.donationId);
    await S.snap("o2", o2.data.donationId);
    await S.step("reminders again", {
      path: "/api/internal/send-pending-reminders",
      headers: { "x-internal-secret": "local-internal-secret" },
    });
  },
  { keep: ["createdAt", "from", "to"], ignoreOutbound: false }
);

await scenario(
  "shop order payment path (webhook + failed)",
  async (S) => {
    const prod =
      (await mdb.collection("products").findOne({ status: { $in: ["published", "active"] } })) ||
      (await mdb.collection("products").findOne({}));
    const items = [
      {
        productId: String(prod._id),
        quantity: 1,
        ...(prod.variants?.[0] ? { variantId: String(prod.variants[0]._id) } : {}),
      },
    ];
    const addr = {
      name: "Shop T",
      phone: donorWithMobile.mobile,
      street: "1 Road",
      city: "Vizag",
      state: "Andhra Pradesh",
      pincode: "530001",
    };
    const ord = (l) =>
      S.step(l, { method: "POST", path: "/shop/orders", token: donorTok, body: { items, shippingAddress: addr } });
    const a = await ord("shop order a");
    const b = await ord("shop order b");
    const rz = (r) => r.data?.razorpayOrderId || r.data?.orderId;
    if (rz(a)) {
      payOrder(envName, S.tag, rz(a), { id: "pay_shop_a" });
      await S.step("shop captured", paidWebhook(S, "shop", rz(a), "pay_shop_a"));
      await S.step("shop captured dup", paidWebhook(S, "default", rz(a), "pay_shop_a"));
    }
    if (rz(b)) {
      await S.step(
        "shop failed",
        event("shop", "payment.failed", {
          payment: { entity: { id: "pay_shop_b", order_id: rz(b), status: "failed" } },
        })
      );
      await S.step(
        "shop failed again",
        event("default", "payment.failed", {
          payment: { entity: { id: "pay_shop_b", order_id: rz(b), status: "failed" } },
        })
      );
    }
    await sleep(1500);
    const num = (r) => r.data?.orderNumber || r.data?.order?.orderNumber;
    for (const r of [a, b])
      if (num(r)) await S.step("my order", { path: `/shop/my-orders/${num(r)}`, token: donorTok });
  },
  { keep: [] }
);

await scenario("upi fallback + qr payment", async (S) => {
  const o = await S.step("order", { method: "POST", path: "/payments/order", body: orderBody() });
  const id = o.data?.donationId;
  await S.step("opened", {
    method: "POST",
    path: "/payments/upi-fallback/opened",
    body: { donationId: id, app: "phonepe", via: "dialog" },
  });
  await S.snap("opened", id);
  await S.step("opened bad id", { method: "POST", path: "/payments/upi-fallback/opened", body: { donationId: "abc" } });
  await S.step("claim", {
    method: "POST",
    path: "/payments/upi-fallback/claim",
    body: { donationId: id, payerName: "Payer P" },
  });
  await S.snap("claimed", id);
  payOrder(envName, S.tag, o.data.orderId, { id: "pay_u1" });
  await S.step("claim after paid", {
    method: "POST",
    path: "/payments/upi-fallback/claim",
    body: { donationId: id, payerName: "Payer P" },
  });
  await sleep(1500);
  await S.snap("after", id);
});

await scenario(
  "concurrency: duplicate webhooks + verify race + charged race",
  async (S) => {
    const o = await S.step("order", { method: "POST", path: "/payments/order", body: orderBody() });
    payOrder(envName, S.tag, o.data.orderId, { id: "pay_c1" });
    await Promise.all([
      ...Array.from({ length: 4 }, () => call(S.url, paidWebhook(S, "default", o.data.orderId, "pay_c1"))),
      call(S.url, {
        method: "POST",
        path: "/payments/verify",
        body: verifyBody("default", o.data.orderId, "pay_c1", o.data.donationId),
      }),
    ]);
    await sleep(3000);
    await S.snap("race", o.data.donationId);
    const s = await S.step("subscription", {
      method: "POST",
      path: "/payments/subscription",
      body: orderBody({ amount: 4004 }),
    });
    const sid = s.data.subscriptionId;
    await call(
      S.url,
      event("default", "subscription.charged", {
        subscription: { entity: { id: sid } },
        payment: { entity: { id: "pay_k1", amount: 400400 } },
      })
    );
    await sleep(2500);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        call(
          S.url,
          event("default", "subscription.charged", {
            subscription: { entity: { id: sid } },
            payment: { entity: { id: "pay_k2", amount: 400400 } },
          })
        )
      )
    );
    await sleep(3000);
    S.t.push({ label: "rows", rows: await rowsBySub(S, sid) });
  },
  { ignoreOutbound: false }
);

console.log(failures ? `\n${failures} scenario(s) differ` : "\nall scenarios identical");
await mongo.close();
await closeDb();
process.exit(failures ? 1 : 0);
