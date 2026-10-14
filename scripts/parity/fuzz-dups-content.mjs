// Duplicate and combined query parameters (Express's simple parser turns repeats into arrays) on every content GET.
//   SRC_MONGO_URI=... node scripts/parity/fuzz-dups-content.mjs http://localhost:9210 http://localhost:9211
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";
import { sign, call, normalize, diff } from "./lib.mjs";

const [A, B, routesFile = "/tmp/routes.json"] = process.argv.slice(2);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const db = mongo.db();
const first = async (c, q = {}) => (await db.collection(c).find(q).sort({ _id: 1 }).limit(1).next()) ?? {};
const admin = String((await first("users", { role: "admin" }))._id);
const ev = await first("events");
const vol = await first("volunteerevents");
const ids = {
  "/events/:id": ev._id,
  "/events/:id/registrations": ev._id,
  "/gallery/:id": (await first("galleries"))._id,
  "/volunteers/:id": vol._id,
  "/volunteers/admin/:id/registrations": vol._id,
  "/important-dates/:id": (await first("importantdates"))._id,
  "/blogs/:idOrSlug": (await first("blogs", { status: "published" }))._id,
  "/blogs/:id/related": (await first("blogs", { status: "published" }))._id,
  "/festival-donations/:slug": (await first("festivaldonations")).slug,
  "/festival-showcases/:slug": (await first("festivalshowcases")).slug,
  "/campaigners/:slug": (await first("campaigners", { status: "active" })).slug,
};
await mongo.close();
const tokens = sign({ userId: admin, role: "admin" });
const PREFIXES = [
  "/blogs",
  "/events",
  "/gallery",
  "/volunteers",
  "/festival-donations",
  "/festival-showcases",
  "/donation-page",
  "/site-content",
  "/hero-banners",
  "/media",
  "/campaigners",
  "/temple-devotees",
  "/important-dates",
  "/contact-messages",
  "/users",
  "/darshan",
  "/ekadashi-campaign",
  "/devotees",
];
const routes = JSON.parse(readFileSync(routesFile, "utf8")).filter(
  (r) => r.method === "GET" && PREFIXES.some((p) => r.path === p || r.path.startsWith(p + "/"))
);
const PARAMS = [
  "q",
  "category",
  "type",
  "status",
  "tag",
  "featured",
  "date",
  "attended",
  "paid",
  "page",
  "limit",
  "preview",
  "all",
  "sort",
  "search",
  "month",
  "days",
];
const PAIRS = [
  ["a", "b"],
  ["published", "draft"],
  ["1", "2"],
  ["true", "false"],
  ["", ""],
  ["Recipes", "Other"],
  ["krishna", "gita"],
  ["-1", "0"],
  ["2026-01-01", "2026-02-01"],
  ["x", "x"],
];
// updatedAt of a post moves a few ms when it is viewed (views $inc); treat timestamps within 250ms as equal.
const align = (a, b) => {
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(a)) {
      if (!(k in b)) continue;
      if (
        typeof a[k] === "string" &&
        typeof b[k] === "string" &&
        /^\d{4}-\d\d-\d\dT/.test(a[k]) &&
        Math.abs(Date.parse(a[k]) - Date.parse(b[k])) < 250
      )
        b[k] = a[k];
      else align(a[k], b[k]);
    }
  }
};
let total = 0,
  bad = 0;
for (const r of routes) {
  const path = r.path.replace(/:([A-Za-z]+)/g, (_, n) => ids[r.path] ?? "abc");
  const queries = [];
  for (const p of PARAMS)
    for (const [x, y] of PAIRS) queries.push(`${p}=${encodeURIComponent(x)}&${p}=${encodeURIComponent(y)}`);
  queries.push(
    "status=published&category=Recipes&limit=2&page=2",
    "q=krishna&status=all&featured=true&tag=a&tag=b",
    "page=2&page=3&limit=1&limit=2&q=a&q=b"
  );
  for (const q of queries) {
    const token = /authMiddleware/.test(r.mw.join()) ? tokens : undefined;
    const [a, b] = [await call(A, { path: `${path}?${q}`, token }), await call(B, { path: `${path}?${q}`, token })];
    total++;
    if (a.status === b.status) align(a.data, b.data);
    const problems =
      a.status !== b.status ? [`status ${a.status} != ${b.status}`] : diff(normalize(a.data), normalize(b.data));
    if (problems.length) {
      bad++;
      if (bad <= 25)
        console.log(
          `DIFF ${r.path}?${q}\n   ${problems.slice(0, 2).join(" | ")}\n   A ${JSON.stringify(a.data)?.slice(0, 140)}\n   B ${JSON.stringify(b.data)?.slice(0, 140)}`
        );
    }
  }
}
console.log(`duplicate/combined params: ${total - bad}/${total} identical over ${routes.length} GET routes`);
process.exit(bad ? 1 : 0);
