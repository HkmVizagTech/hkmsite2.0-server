// Replays mutating donations/donor/DRM requests against the Mongo baseline (A) and the Postgres server (B),
// compares status codes and masked bodies step by step, then compares the resulting database state.
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/writes-donations.mjs http://localhost:9400 http://localhost:9401
// Run `env.sh reset donations` before each run.
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { discover, sign, call, normalize, diff, orderOnly } from "./lib.mjs";

const [A, B] = [process.argv[2], process.argv[3]];
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
const MOBILE1 = "9000000011";
const MOBILE2 = "9000000012";

// ---------- create (fixes 2) ----------
await step("create: missing body", req("POST", "/donations", {}));
await step(
  "create: non-numeric amount (old 500 / new 400)",
  req("POST", "/donations", { donorName: `${MARK} X`, amount: "abc" }),
  { expectDiff: "FIX: amount validated" }
);
await step(
  "create: negative amount (old accepted / new 400)",
  req("POST", "/donations", { donorName: `${MARK} Neg`, amount: -5 }),
  { expectDiff: "FIX: amount validated" }
);
await step(
  "create: no auth (baseline route was public / new route is admin-only)",
  req("POST", "/donations", { donorName: `${MARK} X`, amount: 5 }, { token: null }),
  { expectDiff: "route change by lead: create is admin-only" }
);
// the baseline accepted the two requests above; remove what it created so the state comparison stays aligned
await mdb.collection("donations").deleteMany({ donorName: { $in: [`${MARK} X`, `${MARK} Neg`] } });
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
await step("send-otp: known mobile (WhatsApp unconfigured)", au("/donor-auth/send-otp", { mobile: donorMobile }));
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

const mDon = (
  await mdb
    .collection("donations")
    .find({ donorName: new RegExp(MARK) })
    .sort({ donorName: 1, amount: 1 })
    .toArray()
).map(jsonDoc);
const pDon = (await pgDonations.find({ donorName: { $regex: MARK } }, { sort: { donorName: 1, amount: 1 } })).map(
  jsonDoc
);
const dropVolatile = (d) => {
  const c = { ...d };
  delete c._id;
  delete c.__v;
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
        { mobile: { $in: [donorMobile, "9000000016", "9000000017", "9000000018", "9000000013", "9000000014"] } },
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
        { mobile: { $in: [donorMobile, "9000000016", "9000000017", "9000000018", "9000000013", "9000000014"] } },
        { name: { $regex: MARK } },
      ],
    },
    { sort: { mobile: 1 } }
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
const pIssues = (await pgIssues.find({ subject: { $regex: "Parity" } })).map(jsonDoc);
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
