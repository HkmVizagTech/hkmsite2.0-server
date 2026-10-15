import { MongoClient } from "mongodb";
import pg from "pg";

const m = new MongoClient("mongodb://127.0.0.1:27018/m_cmp"); await m.connect(); const db = m.db();
const p = new pg.Client({ connectionString: "postgres://hkm@localhost:5433/pg_cmp" }); await p.connect();
const q = async (sql) => (await p.query(sql)).rows;
const eq = (name, a, b) => console.log(`${JSON.stringify(a) === JSON.stringify(b) ? "IDENTICAL" : "DIFFERENT "}  ${name}`);
const S = (arr) => [...arr].sort();

const mDon = await db.collection("donations").find({}).toArray();
const pDon = await q("select * from donations");
eq(`donation count (${mDon.length})`, mDon.length, pDon.length);
eq("every donation _id", S(mDon.map((d) => String(d._id))), S(pDon.map((d) => d.id)));
const rel = (docs, key, col) => S(docs.map((d) => `${String(d._id ?? d.id)}=${(key ? d[key] : d[col]) == null ? "" : String(key ? d[key] : d[col])}`));
for (const [mongoKey, pgCol] of [["donorRecordId", "donor_record_id"], ["festivalId", "festival_id"], ["manualEnteredBy", "manual_entered_by"], ["createdBy", "created_by"], ["razorpayOrderId", "razorpay_order_id"], ["razorpayPaymentId", "razorpay_payment_id"], ["subscriptionId", "subscription_id"], ["receiptNumber", "receipt_number"], ["donorId", "donor_id"], ["campaignerSlug", "campaigner_slug"], ["festivalSlug", "festival_slug"], ["transactionId", "transaction_id"], ["utrNumber", "utr_number"], ["whatsappMessageId", "whatsapp_message_id"]])
  eq(`donation -> ${mongoKey} (per donation)`, rel(mDon, mongoKey), S(pDon.map((d) => `${d.id}=${d[pgCol] ?? ""}`)));
eq("total amount, all donations", mDon.reduce((s, d) => s + d.amount, 0), pDon.reduce((s, d) => s + Number(d.amount), 0));
for (const st of ["completed", "failed", "pending", "active", "cancelled"])
  eq(`sum of '${st}' donations`, mDon.filter((d) => d.status === st).reduce((s, d) => s + d.amount, 0), pDon.filter((d) => d.status === st).reduce((s, d) => s + Number(d.amount), 0));

const byDonorM = {}, byDonorP = {};
for (const d of mDon) if (d.donorRecordId) byDonorM[String(d.donorRecordId)] = (byDonorM[String(d.donorRecordId)] ?? 0) + d.amount;
for (const d of pDon) if (d.donor_record_id) byDonorP[d.donor_record_id] = (byDonorP[d.donor_record_id] ?? 0) + Number(d.amount);
eq(`per-donor totals (${Object.keys(byDonorM).length} donors with donations)`, S(Object.entries(byDonorM).map(([k, v]) => `${k}:${v}`)), S(Object.entries(byDonorP).map(([k, v]) => `${k}:${v}`)));

const mDonors = await db.collection("donors").find({}).toArray(); const pDonors = await q("select * from donors");
eq(`donors: ids + donorId + mobile + dccDonorNumber (${mDonors.length})`, S(mDonors.map((d) => `${d._id}|${d.donorId}|${d.mobile}|${d.dccDonorNumber ?? ""}`)), S(pDonors.map((d) => `${d.id}|${d.donor_id}|${d.mobile}|${d.dcc_donor_number ?? ""}`)));
const refs = [["shoporders", "donorRecordId", "shop_orders", "donor_record_id"], ["donorissues", "donorRecordId", "donor_issues", "donor_id"], ["campaigners", "referredByDevotee", "campaigners", "referred_by_devotee_id"], ["festivaldonations", "eventId", "festival_donations", "event_id"], ["registrations", "eventId", "event_registrations", "event_id"], ["volunteerregistrations", "eventId", "volunteer_registrations", "event_id"], ["blogs", "createdBy", "blogs", "created_by"], ["events", "createdBy", "events", "created_by"]];
for (const [coll, key, table, col] of refs) { const ms = await db.collection(coll).find({}).toArray(); const ps = await q(`select id, "${col}" as r from ${table}`); eq(`${coll}.${key} -> ${ps.length} rows`, S(ms.map((d) => `${d._id}=${d[key] ?? ""}`)), S(ps.map((d) => `${d.id}=${d.r ?? ""}`))); }
const mc = await db.collection("counters").find({}).toArray(); const pc = await q("select name, seq from counters");
eq("ID counters (donor ids, order numbers)", S(mc.map((c) => `${c._id}=${c.seq}`)), S(pc.map((c) => `${c.name}=${c.seq}`)));
await m.close(); await p.end();
