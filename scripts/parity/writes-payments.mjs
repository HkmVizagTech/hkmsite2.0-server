#!/usr/bin/env node
// Payments slice parity: Mongo baseline vs Postgres port.
//   export SRC_MONGO_URI=... DATABASE_URL=...   (printed by env.sh up payments)
//   node scripts/parity/writes-payments.mjs http://localhost:9500 http://localhost:9501 [http|select|conc|all]
// Phases:
//   http    identical signed requests (verify / webhooks / status / gupshup callback) against both servers; rows compared after every step
//   select  job selection logic (reconcile, dcc sweep status, pending reminders, resend) run against the baseline Mongo code and the new code on identical fixtures
//   conc    new code only: races on the claim/complete steps with stubbed external APIs
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sign, call, normalize, diff, discover } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = path.resolve(ROOT, "../.localdb/baseline");
const [A, B, phaseArg = "all"] = process.argv.slice(2);
const phases = phaseArg === "all" ? ["http", "select", "conc"] : phaseArg.split(",");
const RZP_SECRET = "local-razorpay-secret";
const WEBHOOK_SECRET = "local-webhook-secret";

if (!process.env.SRC_MONGO_URI || !process.env.DATABASE_URL)
  throw new Error("export SRC_MONGO_URI and DATABASE_URL first");
for (const k of Object.keys(process.env)) if (/^(RAZORPAY|WAPI|DCC|DRM|GUPSHUP|META)_/.test(k)) delete process.env[k];
process.env.MONGO_URI = process.env.SRC_MONGO_URI;

const imp = (p) => import(pathToFileURL(p).href);
const { donationModel: mDon } = await imp(`${BASELINE}/src/models/donation.model.js`);
await mDon.base.connect(process.env.SRC_MONGO_URI);
const mongo = mDon.db;
// Load the baseline services up front, then clear the model registry: the new tree still has files outside this
// slice that register the same mongoose model names, which would otherwise collide in this shared process.
const baseSvc = {
  reconciliation: await imp(`${BASELINE}/src/services/reconciliation.service.js`),
  sweep: await imp(`${BASELINE}/src/services/dccSweep.service.js`),
  completion: await imp(`${BASELINE}/src/services/paymentCompletion.service.js`),
};
for (const n of mDon.base.modelNames()) mDon.base.deleteModel(n);
const { donations: pDon } = await imp(`${ROOT}/src/db/tables.js`);
const { query: pq, closeDb } = await imp(`${ROOT}/src/db/pg.js`);

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");

const hex = (n) => "f1" + n.toString(16).padStart(22, "0");
const FIX_PREFIX_SQL = "f1%";

async function clearFixtures() {
  await mDon.deleteMany({ _id: { $gte: hex(0), $lte: "f1ffffffffffffffffffffff" } });
  await mongo.collection("paymentdowntimes").deleteMany({ downtimeId: /^dt_test/ });
  await mDon.deleteMany({ subscriptionId: /^sub_(S\d|conc|none)/ });
  await pq("DELETE FROM donations WHERE id LIKE $1 OR subscription_id ~ '^sub_(S[0-9]|conc|none)'", [FIX_PREFIX_SQL]);
  await pq("DELETE FROM payment_downtimes WHERE downtime_id LIKE 'dt_test%'");
}
async function seed(docs) {
  for (const d of docs) {
    await mDon.create(d);
    // Mongoose overwrites an explicit updatedAt on create; set it afterwards so both sides carry the same value.
    if (d.updatedAt) await mDon.updateOne({ _id: d._id }, { $set: { updatedAt: d.updatedAt } }, { timestamps: false });
    await pDon.insert(d);
  }
}

const MASK = new Set([
  "updatedAt",
  "receiptGeneratedAt",
  "dccSyncedAt",
  "dccLastAttemptAt",
  "whatsappReceiptSentAt",
  "whatsappThankYouSentAt",
  "lastPaymentDate",
  "lastReconcileCheckAt",
  "closedAsNotPaidAt",
  "whatsappDeliveredAt",
  "metaPurchaseSentAt",
  "dccRecoveredAt",
  "date",
]);
const clean = (v, key) => {
  if (Array.isArray(v)) return v.map((x) => clean(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, k)]));
  if (MASK.has(key) && v != null) return "<t>";
  return v;
};
const plain = (d) => normalize(clean(JSON.parse(JSON.stringify(d))));

async function snapshot(ids) {
  const m = new Map(),
    p = new Map();
  for (const id of ids) {
    const a = await mDon.findById(id).lean(),
      b = await pDon.findById(id);
    m.set(id, a ? plain(a) : null);
    p.set(id, b ? plain(b) : null);
  }
  return { m, p };
}
async function compareRows(label, ids) {
  const { m, p } = await snapshot(ids);
  const bad = [];
  for (const id of ids) {
    const d = diff(m.get(id), p.get(id), id.slice(-3));
    if (d.length) bad.push(...d);
  }
  ok(
    bad.length === 0,
    `${label}: rows ${ids.length} identical${bad.length ? "\n      " + bad.slice(0, 8).join("\n      ") : ""}`
  );
}
const rowOf = async (id) => ({ m: await mDon.findById(id).lean(), p: await pDon.findById(id) });

async function both(req) {
  const [a, b] = await Promise.all([call(A, req), call(B, req)]);
  return { a, b };
}
async function step(label, req, { rows = [], wait = 0, expectDiff = false } = {}) {
  const { a, b } = await both(req);
  if (wait) await sleep(wait);
  if (!expectDiff) {
    const d = diff(plain(a.data ?? null), plain(b.data ?? null));
    ok(
      a.status === b.status && d.length === 0,
      `${label}: status ${a.status}/${b.status}${d.length ? "  body diff: " + d.slice(0, 4).join(" | ") : ""}`
    );
    if (rows.length) await compareRows(label, rows);
  }
  return { a, b };
}
const verifyReq = (body) => ({ method: "POST", path: "/payments/verify", body });
const signedWebhook = (event, hookPath = "/payments/webhook", secret = WEBHOOK_SECRET) => {
  const raw = JSON.stringify(event);
  return {
    method: "POST",
    path: hookPath,
    body: raw,
    headers: { "content-type": "application/json", "x-razorpay-signature": hmac(secret, raw) },
  };
};
const payEntity = (id, orderId, extra = {}) => ({
  payload: {
    payment: {
      entity: {
        id,
        order_id: orderId,
        amount: 50000,
        status: "captured",
        method: "upi",
        created_at: 1790000000,
        ...extra,
      },
    },
  },
});

const now = Date.now();
const ago = (min) => new Date(now - min * 60000);

// ───────────────────────────────────────── phase: http
async function phaseHttp() {
  console.log("\n== http phase ==");
  await clearFixtures();
  const ctx = await discover(process.env.SRC_MONGO_URI);
  const donorRow = (await pq("SELECT id, donor_id FROM donors ORDER BY created_at, id LIMIT 1")).rows[0];
  const base = {
    donorName: "Parity Donor",
    donorEmail: "p@example.com",
    paymentAccount: "default",
    sourcePage: "janmashtami",
    type: "General",
  };
  const D = {
    F1: hex(1),
    F2: hex(2),
    F3: hex(3),
    F4: hex(4),
    F5: hex(5),
    F6: hex(6),
    S1: hex(10),
    S3: hex(11),
    S4: hex(12),
    S5: hex(13),
    S6: hex(14),
    G1: hex(20),
    C1: hex(21),
  };
  await seed([
    { ...base, _id: D.F1, amount: 500, razorpayOrderId: "order_F1", status: "pending", createdAt: ago(60) },
    {
      ...base,
      _id: D.F2,
      amount: 50000,
      razorpayOrderId: "order_F2",
      status: "pending",
      createdAt: ago(60),
      donorName: "Victim Expensive",
    },
    {
      ...base,
      _id: D.F3,
      amount: 100,
      razorpayOrderId: "order_F3",
      status: "pending",
      createdAt: ago(60),
      donorName: "Cheap Attacker",
    },
    { ...base, _id: D.F4, amount: 700, razorpayOrderId: "order_F4", status: "pending", createdAt: ago(50) },
    { ...base, _id: D.F5, amount: 800, razorpayOrderId: "order_F5", status: "pending", createdAt: ago(40) },
    { ...base, _id: D.F6, amount: 900, razorpayOrderId: "order_F6", status: "pending", createdAt: ago(30) },
    {
      ...base,
      _id: D.S1,
      amount: 1000,
      subscriptionId: "sub_S1",
      isRecurring: true,
      status: "pending",
      createdAt: ago(30),
    },
    {
      ...base,
      _id: D.S3,
      amount: 1000,
      subscriptionId: "sub_S3",
      isRecurring: true,
      status: "pending",
      createdAt: ago(30),
    },
    {
      ...base,
      _id: D.S4,
      amount: 1100,
      subscriptionId: "sub_S4",
      isRecurring: true,
      status: "pending",
      createdAt: ago(30),
      campaignerSlug: "camp-x",
      utm: { source: "fb", medium: "cpc", campaign: "c", content: "x", term: "t" },
      sevaName: "Monthly Seva",
      donorMobile: "9000000009",
      donorRecordId: donorRow.id,
      donorId: donorRow.donor_id,
      prasadamAddress: { city: "Vizag", pincode: "530001" },
      wantPrasadam: true,
      dccAttempts: 2,
      whatsappMessageId: "gs-carry",
      whatsappPendingReminderAttempts: 2,
    },
    {
      ...base,
      _id: D.S5,
      amount: 1200,
      subscriptionId: "sub_S5",
      isRecurring: true,
      status: "active",
      createdAt: ago(30),
    },
    {
      ...base,
      _id: D.S6,
      amount: 1300,
      subscriptionId: "sub_S6",
      isRecurring: true,
      status: "active",
      createdAt: ago(30),
    },
    {
      ...base,
      _id: D.G1,
      amount: 300,
      status: "completed",
      receiptNumber: "R|1",
      whatsappReceiptSentAt: ago(10),
      whatsappMessageId: "gs-msg-1",
      whatsappDeliveryStatus: "submitted",
      createdAt: ago(90),
    },
    {
      ...base,
      _id: D.C1,
      amount: 400,
      status: "completed",
      receiptNumber: "R|2",
      razorpayOrderId: "order_C1",
      razorpayPaymentId: "pay_C1",
      createdAt: ago(90),
    },
  ]);
  const all = Object.values(D);
  const rowsStable = all.filter((id) => ![D.F2, D.F3].includes(id));

  await step("verify: missing fields", verifyReq({ razorpay_order_id: "order_F1" }));
  await step(
    "verify: unknown donationId",
    verifyReq({
      razorpay_order_id: "order_zz",
      razorpay_payment_id: "pay_zz",
      razorpay_signature: "x",
      donationId: hex(999),
    })
  );
  await step(
    "verify: unknown order",
    verifyReq({ razorpay_order_id: "order_zz", razorpay_payment_id: "pay_zz", razorpay_signature: "x" })
  );
  await step(
    "verify: bad signature",
    verifyReq({
      razorpay_order_id: "order_F1",
      razorpay_payment_id: "pay_F1",
      razorpay_signature: "deadbeef",
      donationId: D.F1,
    }),
    { rows: rowsStable }
  );
  const goodF1 = verifyReq({
    razorpay_order_id: "order_F1",
    razorpay_payment_id: "pay_F1",
    razorpay_signature: hmac(RZP_SECRET, "order_F1|pay_F1"),
    donationId: D.F1,
  });
  await step("verify: valid (with donationId)", goodF1, { rows: rowsStable, wait: 800 });
  await step("verify: replay of valid", goodF1, { rows: rowsStable, wait: 500 });
  await step(
    "verify: valid by order id only",
    verifyReq({
      razorpay_order_id: "order_F4",
      razorpay_payment_id: "pay_F4",
      razorpay_signature: hmac(RZP_SECRET, "order_F4|pay_F4"),
    }),
    { rows: rowsStable, wait: 800 }
  );
  await step(
    "verify: subscription",
    verifyReq({
      razorpay_subscription_id: "sub_S1",
      razorpay_payment_id: "pay_S1_1",
      razorpay_signature: hmac(RZP_SECRET, "pay_S1_1|sub_S1"),
      donationId: D.S1,
    }),
    { rows: rowsStable, wait: 800 }
  );
  await step(
    "verify: wrong-length signature",
    verifyReq({
      razorpay_order_id: "order_F5",
      razorpay_payment_id: "pay_F5",
      razorpay_signature: "ab",
      donationId: D.F5,
    }),
    { rows: rowsStable }
  );

  // FIX 1: pay for the cheap order, complete the expensive donation.
  const exploit = verifyReq({
    razorpay_order_id: "order_F3",
    razorpay_payment_id: "pay_F3",
    razorpay_signature: hmac(RZP_SECRET, "order_F3|pay_F3"),
    donationId: D.F2,
  });
  const ex = await both(exploit);
  await sleep(800);
  const victim = await rowOf(D.F2);
  ok(
    ex.a.status === 200 && victim.m.status === "completed",
    `exploit works on baseline (status ${ex.a.status}, victim ${victim.m.status}) -- the bug being fixed`
  );
  ok(
    ex.b.status === 400 && victim.p.status === "pending" && !victim.p.razorpayPaymentId,
    `exploit rejected on new (status ${ex.b.status}, victim ${victim.p.status}, body ${JSON.stringify(ex.b.data)})`
  );
  const exSub = await call(
    B,
    verifyReq({
      razorpay_subscription_id: "sub_S3",
      razorpay_payment_id: "pay_x",
      razorpay_signature: hmac(RZP_SECRET, "pay_x|sub_S3"),
      donationId: D.S4,
    })
  );
  ok(exSub.status === 400, `exploit via subscription id mismatch rejected on new (${exSub.status})`);
  const cheap = await rowOf(D.F3);
  ok(cheap.p.status === "pending", "attacker's own donation untouched on new");
  const nonString = await call(
    B,
    verifyReq({ razorpay_order_id: { $ne: null }, razorpay_payment_id: "p", razorpay_signature: "s" })
  );
  ok(nonString.status === 400, `operator-object in verify body rejected on new (${nonString.status})`);

  // webhooks
  await step("webhook: no signature", { method: "POST", path: "/payments/webhook", body: "{}" });
  await step("webhook: bad signature", {
    method: "POST",
    path: "/payments/webhook",
    body: "{}",
    headers: { "x-razorpay-signature": "nope" },
  });
  await step("webhook: touchstone without secret", signedWebhook({ event: "x" }, "/payments/webhook/touchstone"));
  await step("webhook: captured F5", signedWebhook({ event: "payment.captured", ...payEntity("pay_F5", "order_F5") }), {
    rows: rowsStable,
    wait: 1500,
  });
  await step(
    "webhook: captured F5 again (duplicate delivery)",
    signedWebhook({ event: "payment.captured", ...payEntity("pay_F5", "order_F5") }),
    { rows: rowsStable, wait: 1000 }
  );
  await step(
    "webhook: captured without order",
    signedWebhook({ event: "payment.captured", ...payEntity("pay_QR", undefined) }),
    { rows: rowsStable, wait: 500 }
  );
  await step(
    "webhook: captured unknown order",
    signedWebhook({ event: "payment.captured", ...payEntity("pay_U", "order_unknown") }),
    { rows: rowsStable, wait: 800 }
  );
  const failedEvt = {
    event: "payment.failed",
    ...payEntity("pay_F6_1", "order_F6", {
      status: "failed",
      error_code: "BAD_REQUEST_ERROR",
      error_description: "declined",
      error_source: "bank",
      error_step: "payment_authorization",
      error_reason: "insufficient_funds",
    }),
  };
  await step("webhook: payment.failed F6", signedWebhook(failedEvt), { rows: rowsStable, wait: 4000 });
  await step("webhook: payment.failed F6 duplicate", signedWebhook(failedEvt), { rows: rowsStable, wait: 3000 });
  await step(
    "webhook: payment.failed on completed F1",
    signedWebhook({
      event: "payment.failed",
      ...payEntity("pay_F1_x", "order_F1", { status: "failed", error_code: "X" }),
    }),
    { rows: rowsStable, wait: 1500 }
  );
  for (const [ev, id] of [
    ["started", "dt_test1"],
    ["updated", "dt_test1"],
    ["resolved", "dt_test1"],
  ]) {
    await step(
      `webhook: downtime ${ev}`,
      signedWebhook({
        event: `payment.downtime.${ev}`,
        payload: {
          payment: {
            downtime: {
              entity: {
                id,
                method: "upi",
                instrument: { psp: "google_pay" },
                severity: "high",
                status: ev,
                begin: 1790000000,
                end: ev === "resolved" ? 1790003600 : undefined,
              },
            },
          },
        },
      }),
      { wait: 500 }
    );
  }
  const dm = (
    await mongo.collection("paymentdowntimes").find({ downtimeId: "dt_test1" }).sort({ event: 1 }).toArray()
  ).map((x) => plain({ ...x, _id: undefined, receivedAt: undefined }));
  const dp = (await pq("SELECT * FROM payment_downtimes WHERE downtime_id = 'dt_test1' ORDER BY event")).rows.map((r) =>
    plain({
      downtimeId: r.downtime_id,
      event: r.event,
      method: r.method,
      instrument: r.instrument,
      severity: r.severity,
      status: r.status,
      begin: r.begin,
      end: r.end,
    })
  );
  const dd = diff(
    dm.map((x) => ({ ...x })),
    dp
  );
  ok(
    dm.length === 3 && dd.length === 0,
    `downtime rows identical (${dm.length}/${dp.length})${dd.length ? " " + dd.slice(0, 3).join(" | ") : ""}`
  );
  await pq(
    "INSERT INTO payment_downtimes (downtime_id, event, received_at) VALUES ('dt_test_old','x', now() - interval '31 days')"
  );
  await call(
    B,
    signedWebhook({
      event: "payment.downtime.started",
      payload: {
        payment: {
          downtime: { entity: { id: "dt_test2", method: "card", instrument: {}, severity: "low", status: "started" } },
        },
      },
    })
  );
  await sleep(500);
  const old = await pq("SELECT count(*)::int n FROM payment_downtimes WHERE downtime_id = 'dt_test_old'");
  ok(old.rows[0].n === 0, "downtime older than 30 days purged on new insert");

  // subscriptions
  const subEvt = (ev, sub, payment) => ({
    event: ev,
    payload: { subscription: { entity: { id: sub } }, ...(payment ? { payment: { entity: payment } } : {}) },
  });
  await step("webhook: subscription.activated S3", signedWebhook(subEvt("subscription.activated", "sub_S3")), {
    rows: rowsStable,
    wait: 800,
  });
  await step("webhook: subscription.cancelled S5", signedWebhook(subEvt("subscription.cancelled", "sub_S5")), {
    rows: rowsStable,
    wait: 800,
  });
  await step("webhook: subscription.completed S6", signedWebhook(subEvt("subscription.completed", "sub_S6")), {
    rows: rowsStable,
    wait: 800,
  });
  await step(
    "webhook: subscription.charged first charge S4",
    signedWebhook(
      subEvt("subscription.charged", "sub_S4", { id: "pay_S4_1", amount: 110000, subscription_id: "sub_S4" })
    ),
    { rows: rowsStable, wait: 1500 }
  );
  const charge2 = signedWebhook(
    subEvt("subscription.charged", "sub_S4", { id: "pay_S4_2", amount: 120000, subscription_id: "sub_S4" })
  );
  await step("webhook: subscription.charged month 2 (clone)", charge2, { wait: 1500 });
  await step("webhook: subscription.charged month 2 duplicate", charge2, { wait: 1000 });
  await step(
    "webhook: subscription.charged unknown sub",
    signedWebhook(
      subEvt("subscription.charged", "sub_none", { id: "pay_none", amount: 100, subscription_id: "sub_none" })
    ),
    { wait: 500 }
  );
  const clones = async (side) => {
    const docs =
      side === "m"
        ? await mDon.find({ subscriptionId: "sub_S4" }).sort({ createdAt: 1, _id: 1 }).lean()
        : await pDon.find({ subscriptionId: "sub_S4" }, { sort: { createdAt: 1, _id: 1 } });
    return docs.map((d) => {
      const x = plain(d);
      delete x._id;
      delete x.createdAt;
      return x;
    });
  };
  const cm = await clones("m"),
    cp = await clones("p");
  const cd = diff(cm, cp);
  ok(
    cm.length === 2 && cp.length === 2 && cd.length === 0,
    `subscription clone chain identical (${cm.length}/${cp.length} rows)${cd.length ? " " + cd.slice(0, 5).join(" | ") : ""}`
  );
  const stripped = cp[1];
  ok(
    !stripped.receiptNumber &&
      !stripped.dccPayload &&
      !stripped.whatsappReceiptSentAt &&
      stripped.dccSyncStatus === "pending" &&
      stripped.razorpayPaymentId === "pay_S4_2",
    "clone starts without receipt/DCC/whatsapp fields; payment id set"
  );

  // status endpoint
  for (const o of ["order_F1", "order_F4", "order_F5", "order_F6", "order_C1", "order_unknown"])
    await step(`status ${o}`, { path: `/payments/status/${o}` });

  // gupshup delivery callback
  const gs = (type, extra = {}) => ({
    method: "POST",
    path: "/webhooks/whatsapp/gupshup/local-gupshup-secret",
    body: { type: "message-event", payload: { id: "gs-msg-1", type, payload: extra } },
  });
  await step("gupshup: bad secret", {
    method: "POST",
    path: "/webhooks/whatsapp/gupshup/wrong",
    body: gs("sent").body,
  });
  for (const [t, ex] of [
    ["enqueued"],
    ["sent"],
    ["delivered"],
    ["sent"],
    ["read"],
    ["failed", { code: 131026, reason: "not on whatsapp" }],
    ["sent"],
    ["delivered"],
    ["deleted"],
  ]) {
    await step(`gupshup: ${t}`, gs(t, ex), { rows: [D.G1], wait: 400 });
  }
  await step(
    "gupshup: unknown message id",
    {
      method: "POST",
      path: "/webhooks/whatsapp/gupshup/local-gupshup-secret",
      body: { type: "message-event", payload: { id: "nope", type: "sent" } },
    },
    { wait: 300 }
  );

  // admin reconcile (paths that do not call Razorpay)
  const admin = sign({ userId: ctx.admin, role: "admin" });
  await step("reconcile: unknown donation", { method: "POST", path: `/payments/reconcile/${hex(998)}`, token: admin });
  await step("reconcile: already completed", { method: "POST", path: `/payments/reconcile/${D.C1}`, token: admin });
  await step("reconcile: no order id", { method: "POST", path: `/payments/reconcile/${D.S5}`, token: admin });
  await step("reconcile: no auth", { method: "POST", path: `/payments/reconcile/${D.C1}` });
  await step("order: below minimum", { method: "POST", path: "/payments/order", body: { amount: 5, name: "x" } });

  await compareRows("final state of all http fixtures (excluding exploit pair)", rowsStable);
}

// ───────────────────────────────────────── phase: select
async function phaseSelect() {
  console.log("\n== select phase ==");
  await clearFixtures();
  let seedN = 7;
  const rnd = () => (seedN = (seedN * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const docs = [];
  for (let i = 0; i < 220; i++) {
    const status = pick(["pending", "pending", "pending", "failed", "completed", "completed", "active", "cancelled"]);
    const recurring = rnd() < 0.15;
    const d = {
      _id: hex(100 + i),
      donorName: `Sel ${i}`,
      amount: pick([100, 500, 1000, 2100]),
      status,
      type: pick(["General", "Donation", "ANNADAAN", "GO SEVA"]),
      sevaName: pick(["Annadana Seva", "Gau Seva", undefined]),
      paymentAccount: "default",
      createdAt: new Date(
        now - (pick([1, 2, 4, 10, 29, 31, 45, 120, 300, 1500, 1800, 3000, 20000, 200000]) * 60000 + i * 1000)
      ),
      sourcePage: pick([
        undefined,
        "donations",
        "donations/janmashtami2",
        "/donations",
        "janmashtami",
        "sqft-seva-campaign",
        "admin-manual",
        "donationsx",
      ]),
      razorpayOrderId: recurring
        ? undefined
        : pick([`order_sel_${i}`, `order_sel_${i}`, `order_sel_${i}`, undefined, ""]),
      isRecurring: recurring,
      subscriptionId: recurring ? `sub_sel_${i}` : undefined,
      lastReconcileCheckAt: pick([null, null, new Date(now - rnd() * 36e6)]),
      manualEntry: rnd() < 0.1,
      utrNumber: pick([undefined, `UTR${i}`]),
      whatsappPendingReminderSent: rnd() < 0.2,
      whatsappPendingReminderAttempts: pick([0, 0, 1, 2, 3, 4]),
      upiFallback: pick([
        undefined,
        undefined,
        undefined,
        { status: "opened" },
        { status: "claimed" },
        { status: "dismissed" },
        { status: "matched" },
      ]),
      donorMobile: pick(["9000000001", "919000000002", "+919000000003", undefined, "9000000004"]),
      receiptNumber: pick([undefined, undefined, "", "RCPT|" + i]),
      dccSyncStatus: pick(["pending", "syncing", "synced", "failed"]),
      dccAttempts: pick([0, 0, 1, 2, 5, 12]),
      dccLastAttemptAt: pick([undefined, new Date(now - pick([1, 5, 15, 60, 400, 2000]) * 60000)]),
      whatsappReceiptSentAt: pick([undefined, undefined, ago(1000)]),
      dccRecoveredAt: pick([undefined, undefined, ago(60), ago(20000)]),
      razorpayPaymentId: pick([undefined, `pay_sel_${i}`]),
      transactionId: pick([undefined, undefined, `txn_${i}`]),
    };
    d.updatedAt = pick([d.createdAt, new Date(now - 60000), new Date(now - 10 * 60000)]);
    docs.push(d);
  }
  await seed(docs);
  console.log(`seeded ${docs.length} fixtures in both databases`);

  const { reconcilePendingDonations: oldReconcile, closeStalePendingWithoutOrder: oldClose } = baseSvc.reconciliation;
  const { reconcilePendingDonations: newReconcile, closeStalePendingWithoutOrder: newClose } = await imp(
    `${ROOT}/src/services/reconciliation.service.js`
  );
  const ids = (r) => r.results.map((x) => x._id);
  const sameList = (label, a, b) => {
    const eq = JSON.stringify(a) === JSON.stringify(b);
    const sameSet = JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    ok(
      eq,
      `${label}: ${a.length}/${b.length} ids${eq ? ", same order" : sameSet ? " -- same set, DIFFERENT ORDER" : " -- SETS DIFFER"}`
    );
  };
  const quiet = console.log; // reconcile has no logging, but keep the hook for noisy services
  for (const params of [
    {},
    { statuses: ["pending", "failed"] },
    { olderThanMinutes: 30 },
    { olderThanMinutes: 30, statuses: ["pending", "failed"], scope: "all" },
    { scope: "donations-only", statuses: ["pending", "failed", "active"] },
    { scope: "seva", statuses: ["pending", "failed"] },
    { limit: 7, skip: 5, statuses: ["pending", "failed"], scope: "all" },
    { limit: 1000, statuses: ["pending", "failed", "completed"], scope: "all" },
  ]) {
    const a = await oldReconcile({ fix: false, limit: 1000, ...params });
    const b = await newReconcile({ fix: false, limit: 1000, ...params });
    sameList(`reconcile ${JSON.stringify(params)}`, ids(a), ids(b));
    ok(
      JSON.stringify(a.summary) === JSON.stringify(b.summary),
      `reconcile summary ${JSON.stringify(params)} identical`
    );
  }
  const ca = await oldClose({ limit: 1000, fix: false }),
    cb = await newClose({ limit: 1000, fix: false });
  ok(
    JSON.stringify(ca) === JSON.stringify(cb),
    `closeStalePendingWithoutOrder counts ${JSON.stringify(ca)} vs ${JSON.stringify(cb)}`
  );

  const { dccReceiptStatus: oldStatus, autoPushDecision } = baseSvc.sweep;
  const { dccReceiptStatus: newStatus } = await imp(`${ROOT}/src/services/dccSweep.service.js`);
  const donationsScope = {
    $or: [{ sourcePage: /^donations(\/|$)/ }, { sourcePage: "/donations" }, { type: "Donation" }],
  };
  const excludeScope = { sourcePage: { $not: /^donations(\/|$)/ } };
  for (const params of [
    { includeOld: true },
    { includeOld: false },
    { includeOld: true, scope: donationsScope },
    { includeOld: true, scope: excludeScope },
    { listLimit: 10 },
  ]) {
    const a = await oldStatus(params),
      b = await newStatus(params);
    sameList(
      `dccReceiptStatus ${JSON.stringify(params).slice(0, 60)}`,
      a.donations.map((x) => String(x._id)),
      b.donations.map((x) => String(x._id))
    );
    const ja = JSON.stringify(
      plain({
        counts: a.counts,
        rows: a.donations.map(({ createdAt, lastAttemptAt, nextAttemptAt, ...r }) => ({ ...r, _id: String(r._id) })),
      })
    );
    const jb = JSON.stringify(
      plain({
        counts: b.counts,
        rows: b.donations.map(({ createdAt, lastAttemptAt, nextAttemptAt, ...r }) => ({ ...r, _id: String(r._id) })),
      })
    );
    ok(ja === jb, `dccReceiptStatus counts+states ${JSON.stringify(params).slice(0, 60)} identical`);
    if (ja !== jb) {
      const ra = JSON.parse(ja).rows,
        rb = JSON.parse(jb).rows;
      for (let i = 0; i < ra.length; i++)
        if (JSON.stringify(ra[i]) !== JSON.stringify(rb[i]))
          console.log("   row", i, JSON.stringify(ra[i]), "||", JSON.stringify(rb[i]));
    }
  }
  void autoPushDecision;

  // pending reminders: old Mongo filter copied verbatim from the baseline service
  const { findReminderCandidates } = await imp(`${ROOT}/src/services/pendingReminder.service.js`);
  const cutoff = new Date(now - 3 * 60000),
    floor = new Date(now - 24 * 3600000);
  const oldCands = await mDon
    .find({
      status: { $in: ["pending", "failed"] },
      createdAt: { $lte: cutoff, $gte: floor },
      whatsappPendingReminderSent: { $ne: true },
      $or: [{ whatsappPendingReminderAttempts: { $exists: false } }, { whatsappPendingReminderAttempts: { $lt: 3 } }],
      isRecurring: { $ne: true },
      "upiFallback.status": { $nin: ["opened", "claimed", "matched"] },
    })
    .sort({ createdAt: 1 })
    .limit(100);
  const newCands = await findReminderCandidates(cutoff, floor);
  sameList(
    "pending reminder candidates",
    oldCands.map((d) => String(d._id)),
    newCands.map((d) => d._id)
  );
  ok(newCands.length > 3, `reminder fixture non-trivial (${newCands.length} candidates)`);

  // resend failed receipts (dry run lists)
  const { resendRecentFailedReceipts: oldResend } = baseSvc.completion;
  const { resendRecentFailedReceipts: newResend } = await imp(`${ROOT}/src/services/paymentCompletion.service.js`);
  for (const params of [
    { hours: 0, limit: 1000 },
    { hours: 9, limit: 1000 },
    { hours: 100000, limit: 5 },
  ]) {
    const a = await oldResend({ ...params, dryRun: true }),
      b = await newResend({ ...params, dryRun: true });
    sameList(
      `resend dryRun ${JSON.stringify(params)}`,
      a.results.map((x) => x.id),
      b.results.map((x) => x.id)
    );
    const strip = ({ since, results, ...r }) => r;
    ok(
      JSON.stringify(strip(a)) === JSON.stringify(strip(b)),
      `resend dryRun counts ${JSON.stringify(params)} identical (${a.totalMatching}/${b.totalMatching})`
    );
  }
  void quiet;
}

// ───────────────────────────────────────── phase: conc (new code only)
async function phaseConc() {
  console.log("\n== concurrency phase (new code only, external APIs stubbed) ==");
  await clearFixtures();
  process.env.DCC_API_KEY = "stub";
  process.env.WAPI_TOKEN = "stub";
  process.env.DONATION_THANKYOU_ENABLED = "true";
  process.env.RECEIPT_WHATSAPP_PROVIDER = "flaxxa";
  process.env.PENDING_WHATSAPP_PROVIDER = "flaxxa";
  const calls = { dcc: 0, wapi: 0 };
  const realFetch = globalThis.fetch;
  let dccMode = "fail";
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("vhkmsurabhi.com")) {
      calls.dcc++;
      await sleep(300);
      return dccMode === "ok"
        ? new Response(JSON.stringify({ ReceiptNumber: `RC|${calls.dcc}`, DonorNumber: "D1" }), { status: 200 })
        : new Response(JSON.stringify({ Message: "An error has occurred." }), { status: 500 });
    }
    if (u.includes("flaxx") || u.includes("wapi") || u.includes("sendtemplatemessage") || u.includes("/api/v1/")) {
      calls.wapi++;
      await sleep(200);
      return new Response(JSON.stringify({ message_wamid: "wamid.stub", status: "success" }), { status: 200 });
    }
    await sleep(300);
    throw new Error(`stubbed network: ${u.slice(0, 60)}`);
  };

  const axios = (await import("axios")).default;
  const realAxiosPost = axios.post;
  axios.post = async (url) => {
    if (/flaxx|wapi/.test(String(url))) {
      calls.wapi++;
      return { status: 200, data: { status: "success", message_wamid: "wamid.stub" } };
    }
    throw new Error(`stubbed network: ${String(url).slice(0, 60)}`);
  };

  const { completeDonation, markDonationCompleted, handleSubscriptionCharged } = await imp(
    `${ROOT}/src/services/paymentCompletion.service.js`
  );
  const { claimUpdate } = await imp(`${ROOT}/src/domain/donationDb.js`);
  const { recordPaymentFailure } = await imp(`${ROOT}/src/services/paymentFailure.service.js`);
  const mk = (n, o = {}) => ({
    _id: hex(n),
    donorName: "Conc",
    donorEmail: "c@example.com",
    donorMobile: "9000000077",
    amount: 500,
    status: "pending",
    paymentAccount: "default",
    donorRecordId: undefined,
    ...o,
  });
  const nonSeeded = (d) => pDon.insert(d);

  await nonSeeded(mk(1));
  const claims = await Promise.all(
    Array.from({ length: 30 }, () =>
      claimUpdate({ _id: hex(1), status: { $ne: "completed" } }, { status: "completed", razorpayPaymentId: "pay_c1" })
    )
  );
  ok(claims.filter(Boolean).length === 1, `30 parallel complete-claims: ${claims.filter(Boolean).length} winner(s)`);

  await nonSeeded(mk(2, { receiptNumber: "RC|9" }));
  const wa = await Promise.all(
    Array.from({ length: 30 }, () =>
      claimUpdate(
        { _id: hex(2), whatsappSendStatus: { $ne: "sending" }, whatsappReceiptSentAt: null },
        { whatsappSendStatus: "sending" }
      )
    )
  );
  ok(wa.filter(Boolean).length === 1, `30 parallel whatsapp send locks: ${wa.filter(Boolean).length} winner(s)`);

  await nonSeeded(mk(3, { receiptNumber: "RC|9" }));
  const byOrder = async () => {
    await nonSeeded(mk(4, { razorpayOrderId: "order_conc4" }));
    const r = await Promise.all(
      Array.from({ length: 30 }, () => markDonationCompleted({ orderId: "order_conc4", paymentId: "pay_conc4" }))
    );
    return r;
  };
  const r4 = await byOrder();
  ok(
    r4.every((d) => d && d._id === hex(4) && d.status === "completed"),
    "30 parallel markDonationCompleted by order id: all see the completed row"
  );
  ok(
    (await markDonationCompleted({})) === null,
    "markDonationCompleted with no identifier returns null (never matches an arbitrary donation)"
  );

  // DCC never fails over to a second push while another is in flight; thank-you ack sent once
  await nonSeeded(mk(5, { razorpayOrderId: "order_conc5", donorRecordId: undefined }));
  dccMode = "fail";
  calls.dcc = 0;
  calls.wapi = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 20 }, () => completeDonation({ orderId: "order_conc5", paymentId: "pay_conc5" }))
  );
  const r5 = await pDon.findById(hex(5));
  ok(
    calls.dcc === 1,
    `20 parallel completeDonation with failing DCC: ${calls.dcc} DCC push(es) (${Date.now() - t0}ms)`
  );
  ok(calls.wapi === 1, `thank-you acknowledgement sent ${calls.wapi} time(s)`);
  ok(
    r5.status === "completed" && r5.dccSyncStatus === "failed" && r5.dccAttempts === 1 && r5.whatsappThankYouSentAt,
    `row state completed/failed/attempts=1/ack recorded (${r5.status}/${r5.dccSyncStatus}/${r5.dccAttempts})`
  );

  await nonSeeded(mk(6, { razorpayOrderId: "order_conc6" }));
  dccMode = "ok";
  calls.dcc = 0;
  calls.wapi = 0;
  await Promise.all(
    Array.from({ length: 20 }, () => completeDonation({ orderId: "order_conc6", paymentId: "pay_conc6" }))
  );
  const r6 = await pDon.findById(hex(6));
  ok(
    calls.dcc === 1 && r6.receiptNumber === "RC|1" && r6.dccSyncStatus === "synced",
    `20 parallel completeDonation with working DCC: ${calls.dcc} push, receipt ${r6.receiptNumber}, ${r6.dccSyncStatus}`
  );

  // duplicate subscription.charged deliveries produce one clone
  await nonSeeded(
    mk(7, {
      subscriptionId: "sub_conc7",
      isRecurring: true,
      status: "completed",
      receiptNumber: "RC|7",
      razorpayPaymentId: "pay_c7_0",
    })
  );
  const payload = {
    subscription: { entity: { id: "sub_conc7" } },
    payment: { entity: { id: "pay_c7_1", amount: 60000, subscription_id: "sub_conc7" } },
  };
  const res = await Promise.all(Array.from({ length: 6 }, () => handleSubscriptionCharged(payload)));
  const rows7 = await pDon.find({ subscriptionId: "sub_conc7" });
  ok(
    rows7.length === 2 && res.filter((x) => x.ok && !x.skipped).length === 1,
    `6 parallel duplicate subscription.charged: ${rows7.length - 1} clone(s), ${res.filter((x) => x.ok && !x.skipped).length} processed`
  );

  // payment failure counted once per payment id
  await nonSeeded(mk(8));
  const pay = { id: "pay_f8", error_code: "X", error_description: "d", created_at: 1790000000 };
  await Promise.all(Array.from({ length: 10 }, () => recordPaymentFailure(hex(8), pay)));
  await recordPaymentFailure(hex(8), { id: "pay_f8b", error_description: "second", created_at: 1790000100 });
  const r8 = await pDon.findById(hex(8));
  ok(
    r8.failedAttempts === 2 && r8.paymentError.paymentId === "pay_f8b" && !r8.paymentError.code,
    `failure recorded once per payment id (attempts ${r8.failedAttempts}); latest replaces whole paymentError (stale code cleared)`
  );

  // pending reminder: second overlapping pass must not run, each candidate attempted once
  process.env.PENDING_REMINDER_CUTOFF_MINUTES = "3";
  const { runPendingReminders } = await imp(`${ROOT}/src/services/pendingReminder.service.js`);
  for (let i = 0; i < 4; i++)
    await nonSeeded(
      mk(30 + i, {
        donorMobile: `90000009${i}0`,
        createdAt: ago(10 + i),
        razorpayOrderId: `order_rem${i}`,
        bannerImage: undefined,
        sourcePage: "janmashtami",
      })
    );
  const before = calls.wapi;
  void before;
  const [p1, p2] = await Promise.all([runPendingReminders(), sleep(100).then(() => runPendingReminders())]);
  ok(
    p2.skipped && p2.reason === "already_running",
    `overlapping reminder pass skipped (${JSON.stringify({ skipped: p2.skipped, reason: p2.reason })}); first checked ${p1.checked}`
  );
  const remRows = await pDon.find({ _id: { $in: [hex(30), hex(31), hex(32), hex(33)] } });
  ok(
    remRows.every((r) => r.whatsappPendingReminderAttempts + (r.whatsappPendingReminderSent ? 1 : 0) === 1),
    `each reminder candidate attempted exactly once (${remRows.map((r) => `${r.whatsappPendingReminderAttempts}/${!!r.whatsappPendingReminderSent}`).join(" ")})`
  );
  globalThis.fetch = realFetch;
  axios.post = realAxiosPost;
}

try {
  for (const p of phases) await { http: phaseHttp, select: phaseSelect, conc: phaseConc }[p]();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
} finally {
  if (!process.env.KEEP) await clearFixtures().catch(() => {});
  await mDon.base.disconnect();
  await closeDb();
}
process.exit(failures ? 1 : 0);
