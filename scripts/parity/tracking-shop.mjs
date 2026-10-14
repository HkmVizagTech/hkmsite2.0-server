// Runs the auto-tracking job of both builds (in separate processes, courier APIs faked by the mocks) over the same
// seeded shipped orders and compares the orders afterwards. Needs `MOCKS=1 env.sh up|reset <env> <port>`.
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/tracking-shop.mjs <env> http://localhost:<p> http://localhost:<p+1>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import pg from "pg";
import { sign, call, normalize, diff, discover } from "./lib.mjs";
import { setState } from "./mocks/ctl.mjs";

const [envName, A, B] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const local = resolve(root, "../.localdb");
const dir = `${local}/envs/${envName}`;
const ctx = await discover(process.env.SRC_MONGO_URI);
const tok = sign({ userId: ctx.admin, role: "admin" });
const mclient = new MongoClient(process.env.SRC_MONGO_URI, { ignoreUndefined: true });
await mclient.connect();
const mdb = mclient.db();
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const donor = await mdb.collection("donors").findOne({ _id: new ObjectId(ctx.donorWithDonations) });

const DAY = 86400000;
const now = Date.now();
const cases = [
  { n: 1, courier: "Delhivery", awb: "111111111111", status: "Delivered", shippedAt: now - DAY },
  { n: 2, courier: "Delhivery", awb: "222222222222", status: "In Transit", shippedAt: now - 2 * DAY },
  { n: 3, courier: "Delhivery", awb: "333333333333", status: "Out for delivery", shippedAt: now - 2 * DAY },
  { n: 4, courier: "Delhivery", awb: "444444444444", status: "Undelivered - RTO initiated", shippedAt: now - 3 * DAY },
  { n: 5, courier: "", awb: "555555555555", status: "Delivered", shippedAt: now - DAY },
  { n: 6, courier: "", awb: "AB123456789IN", status: "", shippedAt: now - DAY },
  { n: 7, courier: "Delhivery", awb: "777777777777", status: "Delivered", shippedAt: now - 40 * DAY },
  { n: 8, courier: "Delhivery", awb: "888888888888", status: "Delivered", shippedAt: null, createdAt: now - 40 * DAY },
  { n: 9, courier: "Delhivery", awb: "999999999999", status: "Delivered", shippedAt: null, createdAt: now - 2 * DAY },
  { n: 10, courier: "Whatever", awb: "ZZ-1", status: "", shippedAt: now - DAY },
  { n: 11, courier: "Delhivery", awb: "", status: "", shippedAt: now - DAY },
  { n: 12, courier: "Delhivery", awb: "121212121212", status: "In Transit", shippedAt: now - DAY, needsAttention: true },
  { n: 13, courier: "Delhivery", awb: "131313131313", status: "Undelivered - RTO initiated", shippedAt: now - DAY, needsAttention: true },
  { n: 14, courier: "Delhivery", awb: "141414141414", status: "Delivered", shippedAt: now - DAY, fulfilment: "packed" },
];
const ids = cases.map((_, i) => new ObjectId(`6a0000000000000000000a${String(i).padStart(2, "0")}`));
for (const [i, c] of cases.entries()) {
  const id = ids[i];
  const created = new Date(c.createdAt ?? now - 5 * DAY);
  const updated = new Date(now - (cases.length - i) * 1000);
  const orderNumber = `HKMS-TRK-${String(c.n).padStart(3, "0")}`;
  const history = [{ status: "placed", note: "Order created", at: created }];
  await mdb.collection("shoporders").deleteOne({ _id: id });
  await mdb.collection("shoporders").insertOne({
    _id: id, orderNumber, donorRecordId: donor._id, customerName: "Trk", customerMobile: donor.mobile || "9", items: [], subtotal: 1, shippingCharge: 0, total: 1,
    paymentStatus: "paid", fulfilmentStatus: c.fulfilment || "shipped", tracking: { courier: c.courier || undefined, trackingNumber: c.awb, url: undefined },
    shippedAt: c.shippedAt ? new Date(c.shippedAt) : undefined, statusHistory: history, stockShortfall: [], needsAttention: !!c.needsAttention, stockCommitted: true, createdAt: created, updatedAt: updated,
  });
  await pool.query("DELETE FROM shop_orders WHERE id = $1", [String(id)]);
  await pool.query(
    `INSERT INTO shop_orders (id, order_number, donor_record_id, customer_name, customer_mobile, subtotal, shipping_charge, total, payment_status, fulfilment_status,
       tracking_courier, tracking_number, shipped_at, status_history, needs_attention, stock_committed, created_at, updated_at, ship_country)
     VALUES ($1,$2,$3,'Trk',$4,1,0,1,'paid',$5,$6,$7,$8,$9,$10,true,$11,$12,NULL)`,
    [String(id), orderNumber, String(donor._id), donor.mobile || "9", c.fulfilment || "shipped", c.courier || null, c.awb, c.shippedAt ? new Date(c.shippedAt) : null, JSON.stringify(history), !!c.needsAttention, created, updated]
  );
}
const byTracking = Object.fromEntries(cases.filter((c) => c.status).map((c) => [c.awb, c.status]));
setState(envName, "both", { couriers: { default: "", byTracking } });

const mockEnv = (tag, file) => ({
  PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: `${dir}/${file}`, TRACKING_SYNC_ENABLED: "true",
  NODE_OPTIONS: `--import=${root}/scripts/parity/mocks/preload.mjs`, MOCK_STATE: `${dir}/${tag}-mock-state.json`, MOCK_LOG: `${dir}/${tag}-outbound.jsonl`,
  DELHIVERY_TRACKING_API_KEY: "mock-delhivery-key", DTDC_TRACKING_API_KEY: "mock-dtdc-key", BLUEDART_API_KEY: "mock-bluedart-key", BLUEDART_LOGIN_ID: "MOCKLOGIN",
});
const runOnce = () => {
  const base = spawnSync("node", ["-e", `require("dotenv").config({path: process.env.ENV_FILE});
    const mongoose = require("${root}/node_modules/mongoose");
    mongoose.connect(process.env.MONGO_URI).then(async () => { const { runTrackingSync } = require("${local}/baseline/src/jobs/trackingSync.js"); console.log("RESULT " + JSON.stringify(await runTrackingSync())); await mongoose.disconnect(); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });`], { cwd: `${local}/baseline`, env: mockEnv("baseline", "env.mongo"), encoding: "utf8" });
  const next = spawnSync("node", ["--input-type=module", "-e", `import dotenv from "dotenv"; dotenv.config({path: process.env.ENV_FILE});
    const { runTrackingSync } = await import("${root}/src/jobs/trackingSync.js"); const { closeDb } = await import("${root}/src/db/pg.js");
    console.log("RESULT " + JSON.stringify(await runTrackingSync())); await closeDb(); process.exit(0);`], { cwd: root, env: mockEnv("new", "env.pg"), encoding: "utf8" });
  const pick = (r) => (r.stdout.match(/RESULT (.*)/) || [])[1] || `FAILED ${r.stderr.slice(-300)}`;
  return [pick(base), pick(next)];
};

const mask = (s) => s.replace(/[0-9a-f]{24}/g, (m) => (m.startsWith("6a0000000000000000000a") ? m : "<id>")).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<ts>");
const snap = async (base) => {
  const r = await call(base, { path: "/shop-admin/orders?search=HKMS-TRK&limit=100", token: tok });
  return JSON.parse(mask(JSON.stringify(normalize(r.data.orders.map((o) => ({ ...o, updatedAt: o.updatedAt !== undefined })).sort((x, y) => x.orderNumber.localeCompare(y.orderNumber))))));
};
let bad = 0;
for (const round of ["first run", "second run (idempotent)", "all delivered"]) {
  if (round === "all delivered") setState(envName, "both", { couriers: { default: "Delivered", byTracking: {} } });
  const [ra, rb] = runOnce();
  const d = diff(await snap(A), await snap(B));
  console.log(`${round}: baseline ${ra} | new ${rb} | ${d.length ? "DIFF" : "identical"}`);
  if (ra !== rb) {
    bad++;
    console.log("  result differs (intentional guard may explain)");
  }
  d.forEach((x) => console.log("   ", x));
  bad += d.length;
}
await mclient.close();
await pool.end();
process.exit(bad ? 1 : 0);
