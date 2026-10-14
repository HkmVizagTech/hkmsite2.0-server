import { MongoClient, ObjectId } from "mongodb";
import * as T from "../../src/db/tables.js";
import { closeDb } from "../../src/db/pg.js";
import { attachVariants, attachItems } from "../../src/domain/shop.js";
import { normalize, diff } from "./lib.mjs";

const pairs = {
  users: "users",
  donors: "donors",
  donorIssues: "donorissues",
  donations: "donations",
  events: "events",
  registrations: "registrations",
  festivalDonations: "festivaldonations",
  festivalShowcases: "festivalshowcases",
  templeDevotees: "templedevotees",
  campaigners: "campaigners",
  plans: "plans",
  shopCategories: "shopcategories",
  products: "products",
  shopOrders: "shoporders",
  blogs: "blogs",
  contactMessages: "contactmessages",
  darshans: "darshans",
  donationPages: "donationpages",
  siteContent: "sitecontents",
  galleries: "galleries",
  heroBanners: "herobanners",
  importantDates: "importantdates",
  media: "media",
  volunteerEvents: "volunteerevents",
  volunteerRegistrations: "volunteerregistrations",
};
const plain = (v) => {
  if (v instanceof ObjectId) return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};
const IGNORE_TOP = new Set(["__v"]);
const client = new MongoClient(process.env.SRC_MONGO_URI);
await client.connect();
const db = client.db();
let bad = 0;
for (const [repoName, coll] of Object.entries(pairs)) {
  const repo = T[repoName];
  const docs = await db.collection(coll).find({}).toArray();
  let found = await repo.find({}, { lean: true });
  if (repoName === "products") found = await attachVariants(found);
  if (repoName === "shopOrders") found = await attachItems(found);
  const rows = new Map(found.map((r) => [r._id, r]));
  let mismatches = 0,
    shown = 0;
  for (const d of docs) {
    const a = normalize(plain(Object.fromEntries(Object.entries(d).filter(([k]) => !IGNORE_TOP.has(k)))));
    const r = rows.get(String(d._id));
    const b = normalize(r);
    const problems = r ? diff(a, b) : ["row missing"];
    if (problems.length) {
      mismatches++;
      if (shown++ < 2) console.log(`  ${coll} ${d._id}: ${problems.slice(0, 4).join(" | ")}`);
    }
  }
  console.log(
    `${mismatches ? "DIFF" : "ok  "} ${coll}: ${docs.length - mismatches}/${docs.length} documents identical`
  );
  bad += mismatches;
}
await client.close();
await closeDb();
console.log(bad ? `\n${bad} documents differ` : "\nAll documents round-trip identically");
