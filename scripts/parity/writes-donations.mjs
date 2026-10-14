// Replays mutating donations/donor/DRM requests against the Mongo baseline (A) and the Postgres server (B),
// compares status codes and masked bodies step by step, then compares the resulting database state.
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/writes-donations.mjs http://localhost:9400 http://localhost:9401
// Run `env.sh reset donations` before each run.
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { discover, sign, call, normalize, diff, orderOnly } from "./lib.mjs";

import { setState, readLog, compareLogs } from "./mocks/ctl.mjs";

const [A, B] = [process.argv[2], process.argv[3]];
const MOCK_ENV = process.argv[4] || process.env.PARITY_ENV; // env name when the servers run with MOCKS=1
const MONGO = process.env.SRC_MONGO_URI;
const ctx = await discover(MONGO);
const { donations: pgDonations, donors: pgDonors, donorIssues: pgIssues } = await import("../../src/db/tables.js");
const { query, closeDb } = await import("../../src/db/pg.js");

const mongo = new MongoClient(MONGO);
await mongo.connect();
const mdb = mongo.db();
const adminTok = sign({ userId: ctx.admin, role: "admin" });
const internal = { "x-internal-secret": process.env.INTERNAL_SECRET || "local-internal-secret" };
const sides = { A: { base: A, ids: {} }, B: { base: B, ids: {} } };

const HEX = /^[0-9a-f]{24}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
function mask(v) {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "token" ? "<jwt>" : mask(x)]));
  if (typeof v === "string") {
    if (HEX.test(v)) return "<id>";
    if (ISO.test(v)) return "<ts>";
    if (/^TXN[0-9A-F]{6}$/.test(v)) return "<txn>";
    if (/^\d+s ago|filename=/.test(v)) return "<x>";
  }
  return v;
}
const view = (data) => mask(normalize(data));

let pass = 0;
const fails = [];
const expected = [];

// fn(side) -> { status, data }
async function step(name, fn, { expectDiff } = {}) {
  const [a, b] = [await fn(sides.A), await fn(sides.B)];
  const problems = a.status !== b.status ? [`status ${a.status} != ${b.status}`] : diff(view(a.data), view(b.data));
  orderOnly.length = 0;
  if (expectDiff) {
    expected.push(`${name}: ${problems.length ? problems.join("; ") : "no difference"}  (${expectDiff})`);
  } else if (problems.length) fails.push({ name, problems });
  else pass++;
  if (process.env.VERBOSE) console.log(problems.length ? (expectDiff ? "EXPECTED" : "FAIL") : "ok  ", a.status, name);
  return [a, b];
}

const req =
  (method, path, body, opts = {}) =>
  (side) =>
    call(side.base, {
      method,
      path: typeof path === "function" ? path(side) : path,
      body: typeof body === "function" ? body(side) : body,
      token: opts.token === undefined ? adminTok : opts.token,
      headers: opts.headers,
    });
const save =
  (key, pick = (d) => d.donation?._id || d._id) =>
  async (side, res) => {
    side.ids[key] = pick(res.data);
  };

async function create(name, body, key) {
  const [a, b] = await step(name, req("POST", "/donations", body));
  sides.A.ids[key] = a.data?.donation?._id;
  sides.B.ids[key] = b.data?.donation?._id;
}
const id = (key) => (side) => side.ids[key];

const MARK = "ParityTest";
const festivalSlug = (await mdb.collection("festivaldonations").findOne({}))?.slug;
const MOBILE1 = "9000000011";
const MOBILE2 = "9000000012";

// ---------- create (old behaviour kept: amount cast like Mongoose, negatives accepted) ----------
await step("create: missing body", req("POST", "/donations", {}));
await step("create: non-numeric amount", req("POST", "/donations", { donorName: `${MARK} X`, amount: "abc" }));
await step("create: negative amount", req("POST", "/donations", { donorName: `${MARK} Neg`, amount: -5 }));
await step("create: amount '0' string", req("POST", "/donations", { donorName: `${MARK} Zero`, amount: "0" }));
await step("create: fractional amount", req("POST", "/donations", { donorName: `${MARK} Frac`, amount: 12.5 }));
await step("create: amount true", req("POST", "/donations", { donorName: `${MARK} True`, amount: true }));
await step("create: amount object", req("POST", "/donations", { donorName: `${MARK} Obj`, amount: { a: 1 } }));
await step("create: type object", req("POST", "/donations", { donorName: `${MARK} T1`, amount: 5, type: { a: 1 } }));
await step("create: type number", req("POST", "/donations", { donorName: `${MARK} T2`, amount: 5, type: 7 }));
await step(
  "create: certificate yes",
  req("POST", "/donations", { donorName: `${MARK} C1`, amount: 5, certificate: "yes" })
);
await step(
  "create: certificate maybe",
  req("POST", "/donations", { donorName: `${MARK} C2`, amount: 5, certificate: "maybe" })
);
await step(
  "create: bad festivalId",
  req("POST", "/donations", { donorName: `${MARK} F1`, amount: 5, festivalId: "abc" })
);
await step(
  "create: festivalSlug resolves",
  req("POST", "/donations", { donorName: `${MARK} F2`, amount: 5, festivalSlug: festivalSlug || "nope" })
);
await step(
  "create: name as number",
  req("POST", "/donations", { donorName: 12345, amount: 5, donorEmail: 99, prasadamAddress: { city: "X", zip: 1 } })
);
await step(
  "create: address field array",
  req("POST", "/donations", { donorName: `${MARK} A1`, amount: 5, prasadamAddress: { city: ["x"] } })
);
await step(
  "create: unknown/protected fields dropped",
  req("POST", "/donations", {
    donorName: `${MARK} P1`,
    amount: 5,
    status: "completed",
    receiptNumber: "R1",
    sevakName: "S",
  })
);
await step(
  "create: no auth (baseline route was public / new route is admin-only)",
  req("POST", "/donations", { donorName: `${MARK} NoAuth`, amount: 5 }, { token: null }),
  { expectDiff: "route change by lead: create is admin-only" }
);
// the baseline accepted the request above; remove what it created so the state comparison stays aligned
await mdb.collection("donations").deleteMany({ donorName: `${MARK} NoAuth` });
await create(
  "create D1 (prasadam)",
  {
    donorName: `${MARK} One`,
    donorEmail: "parity1@example.com",
    donorMobile: MOBILE1,
    amount: 1500,
    type: "Seva",
    message: "hello",
    panNumber: "ABCDE1234F",
    certificate: true,
    wantPrasadam: true,
    razorpayOrderId: "order_parity1",
    prasadamAddress: { street: "1 Test Rd", city: "Vizag", state: "AP", pincode: "530001", country: "India" },
    status: "completed",
    receiptNumber: "HKMI|FAKE|1",
  },
  "d1"
);
await create("create D2 (plain)", { donorName: `${MARK} Two`, amount: "250", donorMobile: MOBILE2 }, "d2");
await create(
  "create D3 (for manual-complete)",
  { donorName: `${MARK} Three`, amount: 777, donorMobile: "9000000013", donorEmail: "p3@example.com" },
  "d3"
);
await create(
  "create D4 (upi fallback)",
  { donorName: `${MARK} Four`, amount: 333, donorMobile: "9000000014", razorpayOrderId: "order_parity4" },
  "d4"
);
await create(
  "create D5 (upi match)",
  { donorName: `${MARK} Five`, amount: 444, donorMobile: "9000000015", razorpayOrderId: "order_parity5" },
  "d5"
);
await create("create Dh (hack target)", { donorName: `${MARK} Hack`, amount: 10 }, "dh");
await create("create D6 (update variants)", { donorName: `${MARK} Six`, amount: 66, donorMobile: "9000000019" }, "d6");

// ---------- read / update ----------
await step(
  "get D1",
  req("GET", (s) => `/donations/${s.ids.d1}`)
);
await step("get bad id", req("GET", "/donations/zz"));
await step("get unknown id", req("GET", "/donations/000000000000000000000000"));
await step(
  "update D1 editable fields",
  req("PUT", (s) => `/donations/${s.ids.d1}`, {
    donorName: `${MARK} One Edited`,
    message: "edited",
    panNumber: "ZZZZZ9999Z",
    donorMobile: MOBILE1,
  })
);
await step(
  "update D1 empty body",
  req("PUT", (s) => `/donations/${s.ids.d1}`, {})
);
await step(
  "update D6 casts (numbers to strings, bool strings)",
  req("PUT", (s) => `/donations/${s.ids.d6}`, {
    donorName: 12,
    message: true,
    certificate: "yes",
    wantPrasadam: 0,
    dob: "1991-02-03",
  })
);
await step(
  "update D6 null clears",
  req("PUT", (s) => `/donations/${s.ids.d6}`, { message: null, panNumber: null })
);
await step(
  "update D6 array value",
  req("PUT", (s) => `/donations/${s.ids.d6}`, { donorName: ["a"] })
);
await step(
  "update D6 object value",
  req("PUT", (s) => `/donations/${s.ids.d6}`, { message: { a: 1 } })
);
await step(
  "update D6 bad boolean",
  req("PUT", (s) => `/donations/${s.ids.d6}`, { certificate: "maybe" })
);
await step(
  "update D6 address",
  req("PUT", (s) => `/donations/${s.ids.d6}`, {
    wantPrasadam: true,
    prasadamAddress: { city: "Vizag", pincode: "530001" },
  })
);
await step(
  "update D6 empty address object",
  req("PUT", (s) => `/donations/${s.ids.d6}`, { prasadamAddress: {} })
);
await step(
  "get D6 after updates",
  req("GET", (s) => `/donations/${s.ids.d6}`)
);
await step("update unknown id", req("PUT", "/donations/000000000000000000000000", { message: "x" }));
await step("update bad id", req("PUT", "/donations/zz", { message: "x" }));
await step(
  "update no auth",
  req("PUT", (s) => `/donations/${s.ids.d1}`, { message: "x" }, { token: null })
);
await step(
  "update Dh with protected fields (old applied them / new ignores)",
  req("PUT", (s) => `/donations/${s.ids.dh}`, {
    status: "completed",
    receiptNumber: "HKMI|HACK|9",
    amount: 1,
    razorpayPaymentId: "pay_hack",
    dccSyncStatus: "synced",
    message: "ok",
  }),
  { expectDiff: "FIX: PUT whitelists fields" }
);
await step(
  "get Dh after protected update",
  req("GET", (s) => `/donations/${s.ids.dh}`),
  { expectDiff: "FIX: protected fields not writable" }
);
await step(
  "delete Dh",
  req("DELETE", (s) => `/donations/${s.ids.dh}`)
);
await step(
  "get Dh after delete",
  req("GET", (s) => `/donations/${s.ids.dh}`)
);

// ---------- prasadam ----------
const pr = (body) => req("PUT", (s) => `/donations/${s.ids.d1}/prasadam-status`, body);
await step("prasadam: invalid status", pr({ prasadamStatus: "weird" }));
await step(
  "prasadam: dispatched",
  pr({ prasadamStatus: "dispatched", prasadamCourier: " DTDC ", prasadamTrackingNumber: "T123", prasadamNotes: "note" })
);
await step("prasadam: delivered", pr({ prasadamStatus: "delivered" }));
await step("prasadam: back to dispatched", pr({ prasadamStatus: "dispatched" }));
await step("prasadam: pending", pr({ prasadamStatus: "pending", prasadamNotes: "" }));
await step("prasadam: cancelled", pr({ prasadamStatus: "cancelled" }));
await step("prasadam: delivered straight", pr({ prasadamStatus: "delivered", prasadamCourier: "X" }));
await step("prasadam: cancelled again (nothing changes)", pr({ prasadamStatus: "cancelled" }));
await step("prasadam: cancelled again with notes", pr({ prasadamStatus: "cancelled", prasadamNotes: "  zz " }));
await step("prasadam: cancelled same notes", pr({ prasadamStatus: "cancelled", prasadamNotes: "zz" }));
await step("prasadam: courier object", pr({ prasadamStatus: "pending", prasadamCourier: { a: 1 } }));
await step(
  "prasadam: unknown donation",
  req("PUT", "/donations/000000000000000000000000/prasadam-status", { prasadamStatus: "pending" })
);
await step("prasadam: bad id", req("PUT", "/donations/zz/prasadam-status", { prasadamStatus: "pending" }));
await step(
  "prasadam: non-prasadam donation",
  req("PUT", (s) => `/donations/${s.ids.d2}/prasadam-status`, { prasadamStatus: "pending" })
);
await step(
  "get D1 after prasadam",
  req("GET", (s) => `/donations/${s.ids.d1}`)
);

// ---------- manual entry ----------
await step("manual: no name", req("POST", "/donations/manual", { amount: 5, utrNumber: "U1", donorMobile: MOBILE1 }));
await step(
  "manual: bad amount",
  req("POST", "/donations/manual", { donorName: "x", amount: 0, utrNumber: "U1", donorMobile: MOBILE1 })
);
await step("manual: no utr", req("POST", "/donations/manual", { donorName: "x", amount: 5, donorMobile: MOBILE1 }));
await step("manual: no contact", req("POST", "/donations/manual", { donorName: "x", amount: 5, utrNumber: "U1" }));
const [m1a, m1b] = await step(
  "manual: success",
  req("POST", "/donations/manual", {
    donorName: `${MARK} Manual`,
    donorEmail: "PM@Example.com",
    donorMobile: "9000000016",
    amount: 2100,
    utrNumber: "PARITYUTR1",
    manualPaymentMode: "cash",
    sevaName: "Parity Seva",
    certificate: true,
    panNumber: "ABCDE1234F",
    prasadamAddress: { street: "S", city: "C", pincode: "530002" },
    dob: "1990-01-01",
  })
);
sides.A.ids.m1 = m1a.data?.donation?._id;
sides.B.ids.m1 = m1b.data?.donation?._id;
const man = (extra, n) => ({
  donorName: `${MARK} MV${n}`,
  donorMobile: `90000001${40 + n}`,
  amount: 11 + n,
  utrNumber: `PARITYMV${n}`,
  ...extra,
});
let mvn = 0;
for (const [label, extra] of [
  ["type object", { type: { a: 1 } }],
  ["type number", { type: 5 }],
  ["sevaName array", { sevaName: ["x"] }],
  ["dob object + type object", { dob: { y: 1 }, type: { b: 2 } }],
  ["manualEntryNote object", { manualEntryNote: { a: 1 } }],
  ["panNumber array", { panNumber: ["A"] }],
  ["bad paymentDate", { paymentDate: "garbage" }],
  ["paymentDate ok", { paymentDate: "2026-03-04" }],
  ["paymentDate number", { paymentDate: 1700000000000 }],
  ["amount string", { amount: "123.5" }],
  ["amount negative", { amount: -3 }],
  ["amount NaN string", { amount: "abc" }],
  ["address city array", { certificate: true, prasadamAddress: { city: ["q"] } }],
  ["address string", { certificate: true, prasadamAddress: "abc" }],
  ["address not kept without 80G/prasadam", { prasadamAddress: { city: "Z" } }],
  ["wantPrasadam + address", { wantPrasadam: true, prasadamAddress: { city: "Y", pincode: "530005", extra: "x" } }],
  ["sevakName/dob/sevaName", { sevakName: "Sevak", dob: "2000-01-01", sevaName: "S1", transactionId: " pay_zz " }],
  ["bad devoteeId", { devoteeId: "nope" }],
  ["dccEnrolledById string", { dccEnrolledById: "42" }],
  ["dccEnrolledById junk", { dccEnrolledById: "x" }],
  ["note + mode", { manualEntryNote: "  hello  ", manualPaymentMode: "cheque" }],
  ["mode invalid", { manualPaymentMode: "x" }],
  ["email only", { donorMobile: undefined, donorEmail: " Mixed@Case.COM " }],
]) {
  mvn++;
  await step(`manual variant: ${label}`, req("POST", "/donations/manual", man(extra, mvn)));
}
await step(
  "manual: duplicate utr",
  req("POST", "/donations/manual", { donorName: "x", amount: 5, utrNumber: "PARITYUTR1", donorMobile: MOBILE1 })
);
await step(
  "manual: invalid mode + dccEnrolledById",
  req("POST", "/donations/manual", {
    donorName: `${MARK} Manual2`,
    donorMobile: "9000000017",
    amount: 90,
    utrNumber: "PARITYUTR2",
    manualPaymentMode: "bitcoin",
    dccEnrolledById: "12",
  })
);
await step(
  "manual-complete: no utr",
  req("PUT", (s) => `/donations/${s.ids.d3}/manual-complete`, {})
);
await step(
  "manual-complete: unknown",
  req("PUT", "/donations/000000000000000000000000/manual-complete", { utrNumber: "U9" })
);
await step(
  "manual-complete: duplicate utr",
  req("PUT", (s) => `/donations/${s.ids.d3}/manual-complete`, { utrNumber: "PARITYUTR1" })
);
await step(
  "manual-complete: ok",
  req("PUT", (s) => `/donations/${s.ids.d3}/manual-complete`, {
    utrNumber: "PARITYUTR3",
    manualPaymentMode: "bank",
    manualEntryNote: "n",
  })
);
await step(
  "manual-complete: already completed",
  req("PUT", (s) => `/donations/${s.ids.d3}/manual-complete`, { utrNumber: "PARITYUTR4" })
);
await step(
  "get D3 after complete",
  req("GET", (s) => `/donations/${s.ids.d3}`)
);

// ---------- UPI fallback ----------
const up = (path, body) => req("POST", path, body, { token: null });
await step(
  "upi opened: wrong order",
  up("/payments/upi-fallback/opened", (s) => ({ donationId: s.ids.d4, orderId: "nope", app: "phonepe" }))
);
await step("upi opened: bad id", up("/payments/upi-fallback/opened", { donationId: "zz", orderId: "order_parity4" }));
await step(
  "upi opened",
  up("/payments/upi-fallback/opened", (s) => ({
    donationId: s.ids.d4,
    orderId: "order_parity4",
    app: "phonepe",
    via: "strip",
  }))
);
await step(
  "upi claim: short name",
  up("/payments/upi-fallback/claim", (s) => ({ donationId: s.ids.d4, orderId: "order_parity4", payerName: "A" }))
);
await step(
  "upi claim",
  up("/payments/upi-fallback/claim", (s) => ({
    donationId: s.ids.d4,
    orderId: "order_parity4",
    payerName: "  Parity   Payer ",
  }))
);
await step(
  "get D4 after claim",
  req("GET", (s) => `/donations/${s.ids.d4}`)
);
await step(
  "upi opened on D5",
  up("/payments/upi-fallback/opened", (s) => ({ donationId: s.ids.d5, orderId: "order_parity5", app: "other" }))
);
await step("upi-claims all", req("GET", "/donations/upi-claims?status=all"));
await step("upi-claims open", req("GET", "/donations/upi-claims"));
await step("upi-dismiss: bad id", req("POST", "/donations/upi-dismiss", { donationId: "zz" }));
await step(
  "upi-dismiss D4",
  req("POST", "/donations/upi-dismiss", (s) => ({ donationId: s.ids.d4, note: "  not   ours " }))
);
await step(
  "upi-dismiss D4 again",
  req("POST", "/donations/upi-dismiss", (s) => ({ donationId: s.ids.d4 }))
);
await step("upi-match: missing", req("POST", "/donations/upi-match", {}));
await step(
  "upi-match: bad payment id",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d5, paymentId: "xyz" }))
);
await step(
  "upi-match: reference",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d5, reference: "PARITYREF5" }))
);
await step(
  "upi-match: completed already",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d5, reference: "PARITYREF6" }))
);
await step(
  "upi-match: duplicate reference",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d4, reference: "PARITYREF5" }))
);
await step(
  "get D5 after match",
  req("GET", (s) => `/donations/${s.ids.d5}`)
);
await step("upi-claims all after", req("GET", "/donations/upi-claims?status=all"));

// ---------- UPI QR payments through the mock Razorpay ----------
if (MOCK_ENV) {
  const nowEpoch = Math.floor(Date.now() / 1000);
  setState(MOCK_ENV, "both", {
    razorpay: {
      qrPayments: [
        { id: "pay_qr1", amount: 33300, created_at: nowEpoch - 30 },
        { id: "pay_qr2", amount: 44400, created_at: nowEpoch - 60 },
        { id: "pay_qr3", amount: 99900, created_at: nowEpoch - 90 },
      ],
      payments: { pay_qr2: { amount: 44400 }, pay_qr3: { amount: 99900 } },
    },
  });
}
await create(
  "create D7 (upi match by payment id)",
  { donorName: `${MARK} Seven`, amount: 444, donorMobile: "9000000020", razorpayOrderId: "order_parity7" },
  "d7"
);
await step(
  "upi opened on D7",
  up("/payments/upi-fallback/opened", (s) => ({ donationId: s.ids.d7, orderId: "order_parity7" }))
);
await step(
  "upi candidates D4",
  req("GET", (s) => `/donations/upi-claims/${s.ids.d4}/candidates`)
);
await step(
  "upi candidates D7",
  req("GET", (s) => `/donations/upi-claims/${s.ids.d7}/candidates`)
);
await step("upi candidates bad id", req("GET", "/donations/upi-claims/zz/candidates"));
await step("upi candidates unknown", req("GET", "/donations/upi-claims/000000000000000000000000/candidates"));
await step("upi-qr-payments", req("GET", "/donations/upi-qr-payments?days=7"));
await step("upi-qr-payments days=0", req("GET", "/donations/upi-qr-payments?days=0"));
await step(
  "upi-match: payment unknown",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d7, paymentId: "pay_missing" }))
);
await step(
  "upi-match: amount differs",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d7, paymentId: "pay_qr3" }))
);
await step(
  "upi-match: by payment id",
  req("POST", "/donations/upi-match", (s) => ({ donationId: s.ids.d7, paymentId: "pay_qr2" }))
);
await step("upi-qr-payments after match", req("GET", "/donations/upi-qr-payments?days=7"));
await step(
  "get D7 after match",
  req("GET", (s) => `/donations/${s.ids.d7}`)
);

// ---------- resend / admin tools ----------
await step("resend-receipt unknown", req("POST", "/donations/000000000000000000000000/resend-receipt"));
await step(
  "resend-receipt D1",
  req("POST", (s) => `/donations/${s.ids.d1}/resend-receipt`)
);
await step("resend-whatsapp unknown", req("POST", "/donations/000000000000000000000000/resend-whatsapp"));
await step(
  "resend-whatsapp D1",
  req("POST", (s) => `/donations/${s.ids.d1}/resend-whatsapp`)
);
await step(
  "receipt-number: empty",
  req("PUT", (s) => `/donations/${s.ids.d2}/receipt-number`, {})
);
await step("whatsapp-audit fix", req("GET", "/donations/whatsapp-audit?fix=true"));
await step("whatsapp-audit after fix", req("GET", "/donations/whatsapp-audit"));
await step("backfill-donors preview", req("POST", "/donations/backfill-donors?limit=8&skip=3"));
await step("backfill-donors execute", req("POST", "/donations/backfill-donors?limit=6&execute=true"));
await step("backfill-donors preview after", req("POST", "/donations/backfill-donors?limit=8"));
await step("backfill-dcc-donor-numbers preview", req("POST", "/donations/backfill-dcc-donor-numbers?limit=10"));
await step(
  "backfill-dcc-donor-numbers execute",
  req("POST", "/donations/backfill-dcc-donor-numbers?limit=10&execute=true")
);
await step("resend-recent-whatsapp bad hours", req("POST", "/donations/resend-recent-whatsapp", { hours: -1 }));
await step("donations-admin manual-complete: missing", req("POST", "/donations-admin/manual-complete", {}));
await step(
  "donations-admin manual-complete: unknown",
  req("POST", "/donations-admin/manual-complete", {
    donationId: "000000000000000000000000",
    razorpayPaymentId: "pay_x",
  })
);
await step(
  "donations-admin manual-complete: bad id",
  req("POST", "/donations-admin/manual-complete", { donationId: "zz", razorpayPaymentId: "pay_x" })
);
await step(
  "donations-admin manual-complete: completed",
  req("POST", "/donations-admin/manual-complete", (s) => ({ donationId: s.ids.m1, razorpayPaymentId: "pay_x" }))
);
await step(
  "donations-admin reconcile resetChecked",
  req("POST", "/donations-admin/reconcile-pending?limit=3&resetChecked=true")
);
await step("donations-admin dcc push one: bad id", req("POST", "/donations-admin/transactions/zz/dcc-push"));
await step(
  "donations-admin receipt-number: unknown",
  req("PUT", "/donations-admin/transactions/000000000000000000000000/receipt-number", { receiptNumber: "X" })
);

// ---------- delete ----------
await step(
  "delete D2",
  req("DELETE", (s) => `/donations/${s.ids.d2}`)
);
await step(
  "get D2 after delete",
  req("GET", (s) => `/donations/${s.ids.d2}`)
);
await step(
  "delete D2 again",
  req("DELETE", (s) => `/donations/${s.ids.d2}`)
);
await step("delete bad id", req("DELETE", "/donations/zz"));
await step(
  "delete no auth",
  req("DELETE", (s) => `/donations/${s.ids.d1}`, undefined, { token: null })
);

// ---------- donor auth + portal ----------
const donorMobile = ctx.donorMobile;
const otpHash = crypto.createHash("sha256").update("123456").digest("hex");
async function setOtp(attempts = 0, expiresInMs = 600000) {
  const exp = new Date(Date.now() + expiresInMs);
  await mdb
    .collection("donors")
    .updateOne(
      { mobile: donorMobile },
      { $set: { otpCodeHash: otpHash, otpExpiresAt: exp, otpAttempts: attempts }, $unset: { otpLastRequestedAt: "" } }
    );
  await query(
    "UPDATE donors SET otp_code_hash=$1, otp_expires_at=$2, otp_attempts=$3, otp_last_requested_at=NULL WHERE mobile=$4",
    [otpHash, exp, attempts, donorMobile]
  );
}
const au = (path, body) => req("POST", path, body, { token: null });
await step("send-otp: bad mobile", au("/donor-auth/send-otp", { mobile: "123" }));
await step("send-otp: unknown mobile", au("/donor-auth/send-otp", { mobile: "9000000099" }));
await step("send-otp: known mobile", au("/donor-auth/send-otp", { mobile: donorMobile }));
await step("send-otp: known mobile again (cooldown)", au("/donor-auth/send-otp", { mobile: donorMobile }));
await step("shop send-otp: bad mobile", au("/donor-auth/shop/send-otp", { mobile: "12" }));
await step(
  "shop send-otp: new customer",
  au("/donor-auth/shop/send-otp", { mobile: "9000000032", name: "Parity Shop Customer" })
);
await step("shop send-otp: same customer (cooldown)", au("/donor-auth/shop/send-otp", { mobile: "9000000032" }));
await step("verify-otp: missing fields", au("/donor-auth/verify-otp", { mobile: donorMobile }));
await step("verify-otp: unknown mobile", au("/donor-auth/verify-otp", { mobile: "9000000099", otp: "1" }));
await setOtp(0, -1000);
await step("verify-otp: expired", au("/donor-auth/verify-otp", { mobile: donorMobile, otp: "123456" }));
await setOtp(5);
await step("verify-otp: too many attempts", au("/donor-auth/verify-otp", { mobile: donorMobile, otp: "123456" }));
await setOtp(0);
await step("verify-otp: wrong", au("/donor-auth/verify-otp", { mobile: donorMobile, otp: "000000" }));
await step("verify-otp: wrong again", au("/donor-auth/verify-otp", { mobile: donorMobile, otp: "000001" }));
const [va, vb] = await step(
  "verify-otp: correct",
  au("/donor-auth/verify-otp", { mobile: donorMobile, otp: "123456" })
);
await step("verify-otp: reused", au("/donor-auth/verify-otp", { mobile: donorMobile, otp: "123456" }));
const tok = { A: va.data?.token, B: vb.data?.token };
const dreq = (method, path, body) => (side) =>
  call(side.base, { method, path, body, token: tok[side === sides.A ? "A" : "B"] });

await step("donor me", dreq("GET", "/donor/me"));
await step("donor patch: nothing", dreq("PATCH", "/donor/me", {}));
await step("donor patch: empty name", dreq("PATCH", "/donor/me", { name: "  " }));
await step("donor patch: bad email", dreq("PATCH", "/donor/me", { email: "nope" }));
await step("donor patch: bad pan", dreq("PATCH", "/donor/me", { panNumber: "123" }));
await step("donor patch: partial address", dreq("PATCH", "/donor/me", { address: { street: "x" } }));
await step(
  "donor patch: profile",
  dreq("PATCH", "/donor/me", {
    name: ` ${MARK} Donor `,
    email: "parity.donor@example.com",
    panNumber: "abcde1234f",
    address: { street: "5 Main", city: "Vizag", state: "AP", pincode: "530003" },
  })
);
await step("donor me after", dreq("GET", "/donor/me"));
await step(
  "donor patch: clear email/pan/address",
  dreq("PATCH", "/donor/me", { email: "", panNumber: "", address: {} })
);
await step("donor me after clear", dreq("GET", "/donor/me"));
await step("donor issue: missing", dreq("POST", "/donor/issues", { subject: "x" }));
await step(
  "donor issue: create",
  dreq("POST", "/donor/issues", { subject: " Parity subject ", message: " Parity message " })
);
await step("donor issues list", dreq("GET", "/donor/issues"));
await step("donor issue raw keys", async (side) => {
  const r = await dreq("POST", "/donor/issues", { subject: "Parity raw", message: "m" })(side);
  const l = await dreq("GET", "/donor/issues")(side);
  return {
    status: r.status,
    data: { created: Object.keys(r.data.issue || {}).sort(), listed: Object.keys(l.data.issues?.[0] || {}).sort() },
  };
});
await step("donor cancel: unknown subscription", dreq("POST", "/donor/subscriptions/sub_nope/cancel"));
await step("donor receipt: unknown donation", dreq("GET", "/donor/receipt/000000000000000000000000"));
await step("donor my-summary", dreq("GET", "/donor/my-summary"));
await step("donor my-donations", dreq("GET", "/donor/my-donations"));
await step("donor stats", dreq("GET", "/donor/stats"));
await step("donor no token", (side) => call(side.base, { path: "/donor/me" }));

// ---------- preacher ----------
const prTok = sign({ userId: ctx.preacher || ctx.admin, role: "preacher" });
await step(
  "preacher resend-whatsapp unknown",
  req("POST", "/preacher/donations/000000000000000000000000/resend-whatsapp", undefined, { token: prTok })
);
await step(
  "preacher donor donations: unknown",
  req("GET", "/preacher/my-donors/000000000000000000000000/donations", undefined, { token: prTok })
);
await step(
  "preacher donor donations: bad id",
  req("GET", "/preacher/my-donors/zz/donations", undefined, { token: prTok })
);

// raised by a preacher: donor gets assigned, then the preacher views
const [pm1a, pm1b] = await step(
  "preacher raises manual receipt",
  req(
    "POST",
    "/donations/manual",
    { donorName: `${MARK} PreachDonor`, donorMobile: "9000000031", amount: 555, utrNumber: "PARITYPR1" },
    { token: prTok }
  )
);
sides.A.ids.pm1 = pm1a.data?.donation?._id;
sides.B.ids.pm1 = pm1b.data?.donation?._id;
await step(
  "preacher search-donor by mobile",
  req("GET", "/preacher/search-donor?q=9000000031", undefined, { token: prTok })
);
await step(
  "preacher search-donor by name",
  req("GET", `/preacher/search-donor?q=${MARK}`, undefined, { token: prTok })
);
await step("preacher search-donor numeric", req("GET", "/preacher/search-donor?q=100", undefined, { token: prTok }));
await step("preacher search-donor short", req("GET", "/preacher/search-donor?q=ab", undefined, { token: prTok }));
await step("preacher search-donor regex junk", req("GET", "/preacher/search-donor?q=(((", undefined, { token: prTok }));
await step("preacher my-donors", req("GET", "/preacher/my-donors", undefined, { token: prTok }));
await step("preacher my-reports", req("GET", "/preacher/my-reports", undefined, { token: prTok }));
await step(
  "preacher my-reports range",
  req("GET", "/preacher/my-reports?from=2026-01-01&to=2026-12-31", undefined, { token: prTok })
);
await step("preacher my-reports bad range", req("GET", "/preacher/my-reports?from=abc", undefined, { token: prTok }));
const prDonor = (side) =>
  call(side.base, { path: "/preacher/my-donors", token: prTok }).then(
    (r) => r.data?.donors?.find((d) => d.mobile === "9000000031")?._id
  );
sides.A.ids.prd = await prDonor(sides.A);
sides.B.ids.prd = await prDonor(sides.B);
await step(
  "preacher donor donations",
  req("GET", (s) => `/preacher/my-donors/${s.ids.prd}/donations`, undefined, { token: prTok })
);
await step(
  "preacher resend-whatsapp own donation",
  req("POST", (s) => `/preacher/donations/${s.ids.pm1}/resend-whatsapp`, undefined, { token: prTok })
);
await step(
  "preacher resend-whatsapp not theirs",
  req("POST", (s) => `/preacher/donations/${s.ids.d1}/resend-whatsapp`, undefined, { token: prTok })
);

// ---------- DRM / internal ----------
const ir = (method, path, body) => req(method, path, body, { token: null, headers: internal });
await step("internal: no secret", req("GET", "/api/internal/drm/donors", undefined, { token: null }));
await step(
  "internal profile: no mobile match",
  ir("PUT", "/api/internal/drm/donors/by-mobile/9000000099/profile", { name: "x" })
);
await step(
  "internal profile: nothing differs",
  ir("PUT", `/api/internal/drm/donors/by-mobile/${donorMobile}/profile`, {})
);
await step(
  "internal profile: update",
  ir("PUT", `/api/internal/drm/donors/by-mobile/${donorMobile}/profile`, {
    name: `${MARK} DRM Name`,
    email: "drm@example.com",
    panNumber: "fghij5678k",
    address: { street: "9 DRM", city: "Vizag", state: "AP", pincode: "530004" },
  })
);
await step(
  "internal profile: invalid values ignored",
  ir("PUT", `/api/internal/drm/donors/by-mobile/${donorMobile}/profile`, { email: "bad", panNumber: "bad" })
);
await step("internal by-mobile after", ir("GET", `/api/internal/drm/donors/by-mobile/${donorMobile}`));
await step("internal offline donation: missing", ir("POST", "/api/internal/drm/donations/offline", {}));
await step(
  "internal offline donation",
  ir("POST", "/api/internal/drm/donations/offline", {
    donorName: `${MARK} Offline`,
    donorMobile: "9000000018",
    amount: 1001,
    utrNumber: "PARITYDRM1",
    enteredByName: "Tester",
    dccEnrolledById: 77,
  })
);
await step(
  "internal prasadam: bad status",
  ir("PUT", (s) => `/api/internal/drm/donations/${s.ids.d1}/prasadam-status`, { status: "lost" })
);
await step(
  "internal prasadam: shipped",
  ir("PUT", (s) => `/api/internal/drm/donations/${s.ids.d1}/prasadam-status`, {
    status: "shipped",
    courierName: "BlueDart",
    trackingNumber: "BD1",
    notes: "n",
    markedByName: "Tester",
  })
);
await step(
  "internal resend-receipt: unknown",
  ir("POST", "/api/internal/drm/donations/000000000000000000000000/resend-receipt")
);
await step(
  "internal resend-receipt: not completed",
  ir("POST", (s) => `/api/internal/drm/donations/${s.ids.d1}/resend-receipt`)
);
await step("internal abandoned", ir("GET", "/api/internal/drm/abandoned?minMinutes=3&limit=500"));

// ---------- read-backs of derived lists ----------
await step("list: ParityTest search", req("GET", `/donations?q=${MARK}&limit=100`));
await step("list: needs_attention", req("GET", "/donations?status=needs_attention&limit=100"));
await step("stats after writes", req("GET", "/donations/stats"));
await step("report after writes", req("GET", "/donations/report?period=year"));
await step("prasadam list after writes", req("GET", "/donations/prasadam-requests?q=Parity"));
await step("seva-stats overview", req("GET", "/seva-stats/overview", undefined, { token: null }));
await step("dashboard stats", req("GET", "/dashboard/stats"));
await step("donors export for DRM", ir("GET", "/api/internal/drm/donors?limit=200&page=1"));

// ---------- final database state ----------
const stateProblems = [];
const jsonDoc = (d) => view(JSON.parse(JSON.stringify(d)));
function compareState(name, a, b) {
  const p = diff(a, b);
  if (p.length) stateProblems.push(`${name}: ${p.join("; ")}`);
}

const byNameAmount = (a, b) => (a.donorName < b.donorName ? -1 : a.donorName > b.donorName ? 1 : a.amount - b.amount);
const mDon = (
  await mdb
    .collection("donations")
    .find({ donorName: new RegExp(MARK) })
    .toArray()
)
  .map(jsonDoc)
  .sort(byNameAmount);
const pDon = (await pgDonations.find({ donorName: { $regex: MARK } }, { lean: true })).map(jsonDoc).sort(byNameAmount);
const dropVolatile = (d) => {
  const c = { ...d };
  delete c._id;
  delete c.__v;
  delete c.otpCodeHash; // random per send
  delete c.otpExpiresAt;
  delete c.otpLastRequestedAt;
  return c;
};
compareState("donations: ParityTest count", mDon.length, pDon.length);
for (let i = 0; i < Math.min(mDon.length, pDon.length); i++)
  compareState(`donation[${mDon[i].donorName}/${mDon[i].amount}]`, dropVolatile(mDon[i]), dropVolatile(pDon[i]));

const mDonors = (
  await mdb
    .collection("donors")
    .find({
      $or: [
        {
          mobile: {
            $in: [
              donorMobile,
              "9000000016",
              "9000000017",
              "9000000018",
              "9000000013",
              "9000000014",
              "9000000031",
              "9000000032",
            ],
          },
        },
        { name: new RegExp(MARK) },
      ],
    })
    .sort({ mobile: 1 })
    .toArray()
).map(jsonDoc);
const pDonors = (
  await pgDonors.find(
    {
      $or: [
        {
          mobile: {
            $in: [
              donorMobile,
              "9000000016",
              "9000000017",
              "9000000018",
              "9000000013",
              "9000000014",
              "9000000031",
              "9000000032",
            ],
          },
        },
        { name: { $regex: MARK } },
      ],
    },
    { sort: { mobile: 1 }, lean: true }
  )
).map(jsonDoc);
compareState("donors: touched count", mDonors.length, pDonors.length);
for (let i = 0; i < Math.min(mDonors.length, pDonors.length); i++)
  compareState(`donor[${mDonors[i].mobile}]`, dropVolatile(mDonors[i]), dropVolatile(pDonors[i]));

const mIssues = (
  await mdb
    .collection("donorissues")
    .find({ subject: /Parity/ })
    .toArray()
).map(jsonDoc);
const pIssues = (await pgIssues.find({ subject: { $regex: "Parity" } }, { lean: true })).map(jsonDoc);
compareState("donor issues", mIssues.map(dropVolatile), pIssues.map(dropVolatile));

const mAgg = await mdb
  .collection("donations")
  .aggregate([
    {
      $group: {
        _id: "$status",
        n: { $sum: 1 },
        amt: { $sum: "$amount" },
        linked: { $sum: { $cond: [{ $ifNull: ["$donorRecordId", false] }, 1, 0] } },
        rcpt: { $sum: { $cond: [{ $ifNull: ["$receiptNumber", false] }, 1, 0] } },
        wa: { $sum: { $cond: [{ $ifNull: ["$whatsappReceiptSentAt", false] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ])
  .toArray();
const pAgg = (
  await query(
    "SELECT status AS _id, COUNT(*) AS n, SUM(amount) AS amt, COUNT(donor_record_id) AS linked, COUNT(receipt_number) AS rcpt, COUNT(whatsapp_receipt_sent_at) AS wa FROM donations GROUP BY status ORDER BY status"
  )
).rows;
compareState("donations table aggregate by status", view(mAgg), view(pAgg));
compareState(
  "donors total",
  await mdb.collection("donors").countDocuments(),
  Number((await query("SELECT COUNT(*) AS n FROM donors")).rows[0].n)
);
compareState(
  "donor issues total",
  await mdb.collection("donorissues").countDocuments(),
  Number((await query("SELECT COUNT(*) AS n FROM donor_issues")).rows[0].n)
);
compareState(
  "donor counter",
  (await mdb.collection("counters").findOne({ _id: "donorId" }))?.seq ??
    (await mdb.collection("counters").findOne({ name: "donorId" }))?.seq,
  (await query("SELECT seq FROM counters WHERE name='donorId'")).rows[0]?.seq
);

if (MOCK_ENV) {
  const { equal, report } = compareLogs(readLog(MOCK_ENV, "baseline"), readLog(MOCK_ENV, "new"));
  if (!equal) stateProblems.push(`outbound service calls differ: ${String(report).slice(0, 1500)}`);
}

await mongo.close();
await closeDb();

console.log(
  `\nwrites parity: ${pass} steps identical, ${fails.length} differing, ${expected.length} expected (intentional) differences`
);
for (const e of expected) console.log(`  EXPECTED ${e}`);
for (const f of fails) console.log(`\nFAIL ${f.name}\n  ${f.problems.join("\n  ")}`);
console.log(
  stateProblems.length
    ? `\nSTATE DIFFERENCES (${stateProblems.length}):\n  ${stateProblems.join("\n  ")}`
    : "\ndatabase state: identical for all touched donations/donors/issues and table aggregates"
);
process.exit(fails.length || stateProblems.length ? 1 : 0);
