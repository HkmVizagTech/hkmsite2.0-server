// Sets Razorpay live state for the first 40 recurring subscriptions on both fake servers (Monthly Seva screen).
import { MongoClient } from "mongodb";
import { setState } from "./mocks/ctl.mjs";
const ENV = process.argv[2] || "e2e";
const m = new MongoClient(process.env.SRC_MONGO_URI || `mongodb://127.0.0.1:27018/m_${ENV}`);
await m.connect();
const subs = await m.db().collection("donations").aggregate([{ $match: { isRecurring: true, subscriptionId: { $nin: [null, ""] } } }, { $group: { _id: "$subscriptionId" } }, { $limit: 40 }]).toArray();
const st = ["active", "authenticated", "pending", "halted", "cancelled", "completed", "created", "paused", "expired"];
const live = Object.fromEntries(subs.map((s, i) => [s._id, { status: st[i % st.length], paid_count: (i % 5) + 1, remaining_count: 100 - i, charge_at: 1790000000 + i * 1000, ended_at: null }]));
for (const t of ["baseline", "new"]) setState(ENV, t, { razorpay: { subscriptions: live } });
await m.close();
console.log("set", subs.length);
