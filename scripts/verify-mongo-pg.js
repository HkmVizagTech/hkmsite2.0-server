#!/usr/bin/env node
/* Compares Mongo vs Postgres after migrate-mongo-to-pg.js. Read-only on both sides.
 *   SRC_MONGO_URI=... DEST_PG_URL=... node scripts/verify-mongo-pg.js */
import { MongoClient } from "mongodb";
import _pg from "pg";
const { Client } = _pg;
let fails = 0;
// jsonb does not preserve key order, so compare JSON canonically (sorted keys).
const canon = (v) =>
  JSON.stringify(v, (k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((kk) => [kk, x[kk]])
        )
      : x
  );
const check = (name, a, b) => {
  const ok = String(a) === String(b);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: mongo=${a} pg=${b}`);
};
(async () => {
  const m = new MongoClient(process.env.SRC_MONGO_URI);
  await m.connect();
  const db = m.db();
  const pg = new Client({ connectionString: process.env.DEST_PG_URL, ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined });
  await pg.connect();
  const one = async (sql) => (await pg.query(sql)).rows[0].v;

  const pairs = [
    ["users", "users"],
    ["donors", "donors"],
    ["donorissues", "donor_issues"],
    ["events", "events"],
    ["festivaldonations", "festival_donations"],
    ["festivalshowcases", "festival_showcases"],
    ["templedevotees", "temple_devotees"],
    ["campaigners", "campaigners"],
    ["plans", "plans"],
    ["donations", "donations"],
    ["shopcategories", "shop_categories"],
    ["products", "products"],
    ["shoporders", "shop_orders"],
    ["blogs", "blogs"],
    ["contactmessages", "contact_messages"],
    ["donationpages", "donation_pages"],
    ["sitecontents", "site_content"],
    ["galleries", "galleries"],
    ["herobanners", "hero_banners"],
    ["media", "media"],
  ];
  for (const [c, t] of pairs)
    check(`count ${t}`, await db.collection(c).countDocuments(), await one(`select count(*)::int v from ${t}`));

  // donation money: totals per status
  const mStat = await db
    .collection("donations")
    .aggregate([{ $group: { _id: "$status", n: { $sum: 1 }, s: { $sum: "$amount" } } }])
    .toArray();
  const pStat = (await pg.query("select status, count(*)::int n, sum(amount)::float8 s from donations group by status"))
    .rows;
  for (const r of mStat.sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const p = pStat.find((x) => x.status === r._id) || { n: 0, s: 0 };
    check(`donations[${r._id}] count`, r.n, p.n);
    check(`donations[${r._id}] sum`, Math.round(r.s * 100) / 100, Math.round(p.s * 100) / 100);
  }
  // monthly completed totals (what the dashboard shows)
  const mMon = await db
    .collection("donations")
    .aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$date", timezone: "Asia/Kolkata" } },
          s: { $sum: "$amount" },
          n: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const pMon = (
    await pg.query(`select to_char(date at time zone 'Asia/Kolkata','YYYY-MM') m, sum(amount)::float8 s, count(*)::int n
    from donations where status='completed' group by 1 order by 1`)
  ).rows;
  check("monthly buckets (completed)", mMon.length, pMon.length);
  let monthBad = 0;
  mMon.forEach((r, i) => {
    if (!pMon[i] || pMon[i].m !== r._id || pMon[i].n !== r.n || Math.abs(pMon[i].s - r.s) > 0.01) monthBad++;
  });
  check("monthly sums+counts all equal", 0, monthBad);

  // receipts / payments / donors
  check(
    "receipt numbers set",
    await db.collection("donations").countDocuments({ receiptNumber: { $nin: [null, ""] } }),
    await one("select count(*)::int v from donations where receipt_number is not null and receipt_number<>''")
  );
  check(
    "distinct receipt numbers",
    (await db.collection("donations").distinct("receiptNumber")).filter(Boolean).length,
    await one("select count(distinct receipt_number)::int v from donations where receipt_number<>''")
  );
  check(
    "razorpay payment ids set",
    await db.collection("donations").countDocuments({ razorpayPaymentId: { $nin: [null, ""] } }),
    await one("select count(*)::int v from donations where razorpay_payment_id is not null and razorpay_payment_id<>''")
  );
  check(
    "donations linked to donor",
    await db.collection("donations").countDocuments({ donorRecordId: { $ne: null } }),
    await one("select count(*)::int v from donations where donor_record_id is not null")
  );
  check(
    "prasadam requests",
    await db.collection("donations").countDocuments({ wantPrasadam: true }),
    await one("select count(*)::int v from donations where want_prasadam")
  );
  check(
    "recurring",
    await db.collection("donations").countDocuments({ isRecurring: true }),
    await one("select count(*)::int v from donations where is_recurring")
  );
  check(
    "shop orders total sum",
    (
      await db
        .collection("shoporders")
        .aggregate([{ $group: { _id: null, s: { $sum: "$total" } } }])
        .toArray()
    )[0]?.s ?? 0,
    await one("select coalesce(sum(total),0)::float8 v from shop_orders")
  );
  check(
    "blogs published",
    await db.collection("blogs").countDocuments({ status: "published" }),
    await one("select count(*)::int v from blogs where status='published'")
  );
  check(
    "counters",
    JSON.stringify((await db.collection("counters").find().sort({ _id: 1 }).toArray()).map((c) => [c._id, c.seq])),
    JSON.stringify(
      (await pg.query("select name, seq::int from counters order by name")).rows.map((r) => [r.name, r.seq])
    )
  );

  // field-level spot check: 200 random donations, compare key fields
  const sample = await db
    .collection("donations")
    .aggregate([{ $sample: { size: 200 } }])
    .toArray();
  let diff = 0;
  for (const d of sample) {
    const r = (await pg.query("select * from donations where id=$1", [String(d._id)])).rows[0];
    const pairs2 = [
      [d.donorName, r?.donor_name],
      [d.donorMobile ?? null, r?.donor_mobile],
      [d.status, r?.status],
      [d.receiptNumber ?? null, r?.receipt_number],
      [d.razorpayOrderId ?? null, r?.razorpay_order_id],
      [d.panNumber ?? null, r?.pan_number],
      [d.sevaName ?? null, r?.seva_name],
      [d.prasadamAddress?.pincode ?? null, r?.prasadam_pincode],
      [d.utm?.source ?? "", r?.utm_source],
      [Number(d.amount), Number(r?.amount)],
      [d.date ? new Date(d.date).getTime() : null, r?.date ? new Date(r.date).getTime() : null],
      [canon(d.dccResponse ?? null), canon(r?.dcc_response ?? null)],
      [canon(d.dccPayload ?? null), canon(r?.dcc_payload ?? null)],
    ];
    if (pairs2.some(([a, b]) => String(a) !== String(b))) {
      diff++;
      if (diff <= 3)
        console.log(
          "  diff sample",
          String(d._id),
          pairs2
            .filter(([a, b]) => String(a) !== String(b))
            .map(([a, b]) => [String(a).slice(0, 60), String(b).slice(0, 60)])
        );
    }
  }
  check("random-sample field diffs (200 donations)", 0, diff);

  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  await pg.end();
  await m.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
