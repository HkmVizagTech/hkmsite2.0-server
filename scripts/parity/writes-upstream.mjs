// Parity for the upstream features ported after the Postgres migration: events slug, event registration fee,
// Monthly Seva list, /payments/verify hardening, subscription.activated guard.
//   MOCKS=1 scripts/parity/env.sh reset e2e   (baseline :9100 = upstream main on Mongo, new :9101 = Postgres)
//   SRC_MONGO_URI=... node scripts/parity/writes-upstream.mjs http://localhost:9100 http://localhost:9101 [e2e]
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { sign, call, diff } from "./lib.mjs";
import { setState, resetMocks, payOrder, signWebhook } from "./mocks/ctl.mjs";

const [A, B, ENV = "e2e"] = process.argv.slice(2);
const mongo = new MongoClient(process.env.SRC_MONGO_URI || `mongodb://127.0.0.1:27018/m_${ENV}`);
await mongo.connect();
const mdb = mongo.db();
const admin = await mdb.collection("users").findOne({ role: "admin" });
const tok = sign({ userId: String(admin._id), role: "admin" });
resetMocks(ENV);

const mask = (v) =>
  JSON.parse(
    JSON.stringify(v ?? null)
      .replace(/[0-9a-f]{24}/gi, "<id>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, (m) => (/T00:00:00/.test(m) ? m : "<ts>"))
      .replace(/order_Mock\w+/g, "<order>")
  );
const strip = (o) => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, x] of Object.entries(o)) if (!["__v", "liveCheckedAt"].includes(k)) r[k] = strip(x);
    return r;
  }
  return o;
};

async function http(base, { method = "GET", path, json, form, auth = true, headers = {} }) {
  const h = { ...headers };
  if (auth) h.authorization = `Bearer ${tok}`;
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = typeof json === "string" ? json : JSON.stringify(json);
  } else if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(base + path, { method, headers: h, body });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

let fails = 0,
  total = 0;
const ids = {}; // name -> { A, B } ids captured from earlier responses
async function step(name, spec, { capture } = {}) {
  total++;
  const sp = (base, tag) => {
    const s = typeof spec === "function" ? spec(tag) : spec;
    return { ...s, path: s.path.replace(/\{(\w+)\}/g, (_, k) => ids[k]?.[tag] ?? k) };
  };
  const ra = await http(A, sp(A, "A"));
  const rb = await http(B, sp(B, "B"));
  if (capture) for (const [k, fn] of Object.entries(capture)) ids[k] = { A: fn(ra.data), B: fn(rb.data) };
  const d = [];
  if (ra.status !== rb.status) d.push(`status ${ra.status} != ${rb.status}`);
  diff(strip(mask(ra.data)), strip(mask(rb.data)), "$", d);
  if (d.length) {
    fails++;
    console.log(`FAIL ${name}\n   ${d.slice(0, 6).join("\n   ")}`);
  } else console.log(`ok   ${name} [${ra.status}]`);
  return { ra, rb };
}

const events = (await http(A, { path: "/events", auth: false })).data.events;
const evPaid = events.find((e) => e.registrationForm?.payment?.enabled) || events[0];
const evFree = events.find((e) => e._id !== evPaid._id) || events[0];
ids.paid = { A: evPaid._id, B: evPaid._id };
ids.free = { A: evFree._id, B: evFree._id };
console.log("existing events:", events.map((e) => `${e.slug} paid=${!!e.registrationForm?.payment?.enabled}`).join(" | "));

// ---- events slug -----------------------------------------------------------
await step("list events", { path: "/events", auth: false });
await step("get by id", { path: "/events/{paid}", auth: false });
await step("get by current slug", { path: `/events/${evPaid.slug}`, auth: false });
await step("get by uppercase slug", { path: `/events/${evPaid.slug.toUpperCase()}`, auth: false });
await step("get unknown slug 404", { path: "/events/no-such-event-xyz", auth: false });
await step("get unknown id 404", { path: "/events/000000000000000000000000", auth: false });

const mk = (title, extra = {}) => ({ method: "POST", path: "/events", form: { title, description: "d", date: "2026-12-25", category: "General", status: "upcoming", ...extra } });
await step("create event (slug from title)", mk("Slug Test Event"), { capture: { e1: (d) => d?.event?._id } });
await step("create event same title (-2)", mk("Slug Test Event"), { capture: { e2: (d) => d?.event?._id } });
await step("create event explicit slug", mk("Other Title", { slug: "Custom Slug!!" }), { capture: { e3: (d) => d?.event?._id } });
await step("create event id-like slug", mk("Plain", { slug: "6ad5df93a15650ed48f6e09a" }), { capture: { e4: (d) => d?.event?._id } });
await step("create telugu title", mk("గీతా జయంతి ఉత్సవం"), { capture: { e5: (d) => d?.event?._id } });
await step("get created by slug", { path: "/events/slug-test-event", auth: false });
await step("get created by slug -2", { path: "/events/slug-test-event-2", auth: false });
const up = (id, form) => ({ method: "PUT", path: `/events/{${id}}`, form });
await step("update title only keeps slug", up("e1", { title: "Slug Test Event Renamed", description: "d", date: "2026-12-25" }));
await step("update slug (old kept in previousSlugs)", up("e1", { title: "Slug Test Event Renamed", description: "d", date: "2026-12-25", slug: "Brand New Slug" }));
await step("get by previous slug", { path: "/events/slug-test-event", auth: false });
await step("update slug to one already taken", up("e1", { title: "x", description: "d", date: "2026-12-25", slug: "custom-slug" }));
await step("update slug back to a previous one", up("e1", { title: "x", description: "d", date: "2026-12-25", slug: "slug-test-event" }));
await step("update ignoring client previousSlugs", up("e2", { title: "x", description: "d", date: "2026-12-25", previousSlugs: ["evil"] }));
await step("update blank slug keeps old", up("e3", { title: "x", description: "d", date: "2026-12-25", slug: "   " }));
await step("update unknown event 404", { method: "PUT", path: "/events/000000000000000000000000", form: { title: "x", description: "d", date: "2026-12-25" } });
await step("list events after edits", { path: "/events", auth: false });

// ---- registration fee ------------------------------------------------------
const feeForm = { payment: { enabled: true, price: 99, studentPrice: 49, jobPrice: 149 }, fields: [] };
await step("create paid event", mk("Paid Workshop", { registrationForm: feeForm }), { capture: { p1: (d) => d?.event?._id } });
await step("create paid event single price", mk("Paid Single", { registrationForm: { payment: { enabled: true, price: 200 } } }), { capture: { p2: (d) => d?.event?._id } });
await step("create paid event enabled, no price", mk("Paid Nothing", { registrationForm: { payment: { enabled: true } } }), { capture: { p3: (d) => d?.event?._id } });
const reg = (id, body) => ({ method: "POST", path: `/events/{${id}}/register`, auth: false, form: body });
await step("register free event (paymentChoice stripped)", reg("e3", { name: "Free Person", phone: "9876543210", paymentChoice: "general" }), { capture: { r0: (d) => d?.id } });
await step("register paid: no choice -> 400", reg("p1", { name: "A" }));
await step("register paid: bad choice -> 400", reg("p1", { name: "A", paymentChoice: "vip" }));
const regPaid = await step("register paid: student -> order", reg("p1", { name: "Stu", phone: "9000000001", paymentChoice: "student" }), { capture: { r1: (d) => d?.id, t1: (d) => d?.token, o1: (d) => d?.payment?.orderId } });
await step("register paid single price (no choice needed)", reg("p2", { name: "Single", phone: "9000000002" }), { capture: { r2: (d) => d?.id, t2: (d) => d?.token, o2: (d) => d?.payment?.orderId } });
await step("register paid enabled but unpriced = free", reg("p3", { name: "Free2" }));
await step("register bad event id 404", { method: "POST", path: "/events/not-an-id/register", auth: false, form: { name: "x" } });
await step("register unknown event 404", { method: "POST", path: "/events/000000000000000000000000/register", auth: false, form: { name: "x" } });
await step("registrations list (admin)", { path: "/events/{p1}/registrations" });
await step("checkin while fee pending -> 402", { method: "POST", path: "/events/{p1}/checkin/{t1}", auth: false });
await step("checkin free registration ok", { method: "POST", path: "/events/{e3}/checkin/x", auth: false });
const KEY_SECRET = "local-razorpay-secret";
const sig = (o, p) => crypto.createHmac("sha256", KEY_SECRET).update(`${o}|${p}`).digest("hex");
const vp = (rid, tag, over = {}) => (t) => {
  const o = ids.o1[t], p = "pay_UP1";
  return { method: "POST", path: `/events/{p1}/registrations/{${rid}}/verify-payment`, auth: false, json: { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: sig(o, p), ...over } };
};
await step("verify-payment missing fields 400", { method: "POST", path: "/events/{p1}/registrations/{r1}/verify-payment", auth: false, json: {} });
await step("verify-payment bad reg id 400", { method: "POST", path: "/events/{p1}/registrations/zzz/verify-payment", auth: false, json: { razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s" } });
await step("verify-payment unknown reg 404", { method: "POST", path: "/events/{p1}/registrations/000000000000000000000000/verify-payment", auth: false, json: { razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s" } });
await step("verify-payment wrong order 400", (t) => ({ method: "POST", path: "/events/{p1}/registrations/{r1}/verify-payment", auth: false, json: { razorpay_order_id: "order_other", razorpay_payment_id: "pay_UP1", razorpay_signature: "x" } }));
await step("verify-payment bad signature 400", (t) => ({ method: "POST", path: "/events/{p1}/registrations/{r1}/verify-payment", auth: false, json: { razorpay_order_id: ids.o1[t], razorpay_payment_id: "pay_UP1", razorpay_signature: "nope" } }));
await step("verify-payment non-string fields 400", { method: "POST", path: "/events/{p1}/registrations/{r1}/verify-payment", auth: false, json: { razorpay_order_id: { $ne: 1 }, razorpay_payment_id: ["a"], razorpay_signature: 5 } });
await step("verify-payment ok", vp("r1"));
await step("verify-payment repeat ok", vp("r1"));
await step("checkin after paid ok", { method: "POST", path: "/events/{p1}/checkin/{t1}", auth: false });
await step("registrations list after pay", { path: "/events/{p1}/registrations" });
await step("registrations filter paid=true", { path: "/events/{p1}/registrations?paid=true" });

// webhook path: visitor closed the page; payment.captured marks the registration paid
for (const tag of ["baseline", "new"]) payOrder(ENV, tag, tag === "baseline" ? ids.o2.A : ids.o2.B, { id: "pay_UP2" });
const hook = async (base, tag) => {
  const o = tag === "A" ? ids.o2.A : ids.o2.B;
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_UP2", order_id: o, amount: 20000, status: "captured", method: "upi", notes: {} } } } });
  const r = await fetch(base + "/payments/webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signWebhook("local-webhook-secret", raw) }, body: raw });
  return { status: r.status, data: await r.text() };
};
{
  total++;
  const a = await hook(A, "A"), b = await hook(B, "B");
  const ok = a.status === b.status && a.data === b.data;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} payment.captured webhook for a registration order [${a.status}/${b.status}] ${ok ? "" : a.data + " != " + b.data}`);
}
await new Promise((r) => setTimeout(r, 800));
await step("registrations list after webhook", { path: "/events/{p2}/registrations" });
await step("checkin after webhook-paid", { method: "POST", path: "/events/{p2}/checkin/{t2}", auth: false });

// ---- Monthly Seva list -----------------------------------------------------
const subs = await mdb.collection("donations").aggregate([{ $match: { isRecurring: true, subscriptionId: { $nin: [null, ""] } } }, { $group: { _id: "$subscriptionId", acc: { $first: "$paymentAccount" } } }, { $limit: 40 }]).toArray();
const statuses = ["active", "authenticated", "pending", "halted", "cancelled", "completed", "created", "paused", "expired"];
const live = {};
subs.forEach((s, i) => (live[s._id] = { status: statuses[i % statuses.length], paid_count: (i % 5) + 1, remaining_count: 100 - i, charge_at: 1790000000 + i * 1000, ended_at: i % 4 === 0 ? 1795000000 : null }));
for (const tag of ["baseline", "new"]) setState(ENV, tag, { razorpay: { subscriptions: live } });
console.log(`monthly seva: ${subs.length} subscriptions, mocked live state`);
for (const q of ["", "?status=active", "?status=failing", "?attention=1", "?search=a&limit=5&page=2", "?fresh=1&limit=50", "?status=ended&seva=Monthly%20Seva", "?limit=0", "?page=-3&status=bogus"])
  await step(`GET /donations/subscriptions${q}`, { path: `/donations/subscriptions${q}` });
await step("subscriptions requires auth", { path: "/donations/subscriptions", auth: false });

// ---- /payments/verify hardening -------------------------------------------
const pend = await mdb.collection("donations").find({ status: { $in: ["pending", "failed"] }, razorpayOrderId: { $type: "string" } }).limit(2).toArray();
const done = await mdb.collection("donations").findOne({ status: "completed", razorpayPaymentId: { $type: "string" } });
const subDon = await mdb.collection("donations").findOne({ isRecurring: true, subscriptionId: { $type: "string" }, status: "completed" });
const V = (json) => ({ method: "POST", path: "/payments/verify", auth: false, json });
const rsig = (o, p) => crypto.createHmac("sha256", KEY_SECRET).update(`${o}|${p}`).digest("hex");
await step("verify: nothing", V({}));
await step("verify: object fields", V({ razorpay_payment_id: { $ne: 1 }, razorpay_signature: "x", razorpay_order_id: "o" }));
await step("verify: numeric payment id", V({ razorpay_payment_id: 12345, razorpay_signature: "x", razorpay_order_id: "o" }));
await step("verify: donationId not hex", V({ razorpay_payment_id: "p", razorpay_signature: "s", razorpay_order_id: "o", donationId: "abc" }));
await step("verify: donationId operator", V({ razorpay_payment_id: "p", razorpay_signature: "s", razorpay_order_id: "o", donationId: { $ne: null } }));
await step("verify: donation not found", V({ razorpay_payment_id: "p", razorpay_signature: "s", razorpay_order_id: "order_nope" }));
await step("verify: unknown donationId 404", V({ razorpay_payment_id: "p", razorpay_signature: "s", razorpay_order_id: "o", donationId: "000000000000000000000000" }));
await step("verify: uppercase donationId", V({ razorpay_payment_id: "p", razorpay_signature: "s", razorpay_order_id: pend[0].razorpayOrderId, donationId: String(pend[0]._id).toUpperCase() }));
await step("verify: order of another donation 400", V({ razorpay_payment_id: "pay_x", razorpay_signature: "s", razorpay_order_id: pend[1].razorpayOrderId, donationId: String(pend[0]._id) }));
await step("verify: bad signature", V({ razorpay_payment_id: "pay_x", razorpay_signature: "bad", razorpay_order_id: pend[0].razorpayOrderId }));
await step("verify: payment already on another donation 409", V({ razorpay_payment_id: done.razorpayPaymentId, razorpay_signature: rsig(pend[0].razorpayOrderId, done.razorpayPaymentId), razorpay_order_id: pend[0].razorpayOrderId, donationId: String(pend[0]._id) }));
await step("verify: subscription of another donation", V({ razorpay_payment_id: "pay_x", razorpay_signature: "s", razorpay_subscription_id: "sub_nope" }));
await step("verify: subscription id mismatch w/ donationId", V({ razorpay_payment_id: "pay_x", razorpay_signature: "s", razorpay_subscription_id: subDon.subscriptionId, donationId: String(pend[0]._id) }));

console.log(`\nupstream parity: ${total - fails}/${total} steps identical${fails ? `, ${fails} DIFFERENT` : ""}`);
await mongo.close();
process.exit(fails ? 1 : 0);
