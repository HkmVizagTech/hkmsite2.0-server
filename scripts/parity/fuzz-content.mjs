import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";
import { sign, call, normalize, diff, discover, orderOnly } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const [A, B, routesFile, prefix = "/"] = args.filter((a) => !a.startsWith("--"));
const quick = flag("quick");
const basesFile = opt("bases");
const bases = basesFile ? (await import(pathToFileURL(basesFile).href)).default : {};
const routes = JSON.parse(readFileSync(routesFile, "utf8")).filter((r) => r.path.startsWith(prefix));
const ctx = await discover(process.env.SRC_MONGO_URI);
// Content-slice fixtures: real documents for every route that takes an id/slug/token.
const mc = await MongoClient.connect(process.env.SRC_MONGO_URI);
const mdb = mc.db();
const firstId = async (c, q = {}) =>
  String((await mdb.collection(c).find(q).sort({ _id: 1 }).limit(1).next())?._id ?? "");
const fx = {
  media: await firstId("media"),
  banner: await firstId("herobanners"),
  date: await firstId("importantdates"),
  message: await firstId("contactmessages"),
  devotee: await firstId("templedevotees", { status: "active" }),
  volReg: await firstId("volunteerregistrations"),
  reg: await mdb.collection("registrations").findOne({}, { sort: { _id: 1 } }),
  festivalSlug: (await mdb.collection("festivaldonations").findOne({ slug: { $ne: "" } }))?.slug ?? "x",
  showcaseSlug: (await mdb.collection("festivalshowcases").findOne({}))?.slug ?? "x",
  campaignerSlug: (await mdb.collection("campaigners").findOne({ status: "active" }))?.slug ?? "x",
  blogSlug: ctx.blog?.slug ?? "x",
};
const preIds = new Set();
for (const { name: c } of await mdb.listCollections().toArray())
  for (const d of await mdb
    .collection(c)
    .find({}, { projection: { _id: 1 } })
    .toArray())
    preIds.add(String(d._id));
await mc.close();
// Ids and timestamps the servers generate during the run are masked; pre-existing ones are compared.
const NOW = Date.now();
const maskGenerated = (v) => {
  if (Array.isArray(v)) return v.map(maskGenerated);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskGenerated(x)]));
  if (typeof v === "string") {
    if (/^[0-9a-f]{24}$/.test(v) && !preIds.has(v)) return "<new-id>";
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && Math.abs(Date.parse(v) - NOW) < 3600e3) return "<now>";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(v)) return "<uuid>";
  }
  return v;
};

const SKIP =
  /\/(login|logout|webhook|webhooks|send-otp|verify-otp|upload|upload-image|upload-inline|sync|resend|dcc-push|push-all|reconcile|backfill|manual-complete|upi-match|order|subscription)\b|\/health$/;
const tokens = {
  admin: sign({ userId: ctx.admin, role: "admin" }),
  donor: sign({ donorId: ctx.donorWithDonations, type: "donor" }),
};
const identity = (r) =>
  r.path.startsWith("/api/internal")
    ? "internal"
    : r.mw.includes("donorAuthMiddleware")
      ? "donor"
      : r.mw.includes("authMiddleware")
        ? "admin"
        : "none";
const realIds = {
  donations: ctx.donation?._id,
  "donations-admin": ctx.donation?._id,
  blogs: ctx.blog?._id,
  events: ctx.event?._id,
  gallery: ctx.gallery?._id,
  volunteers: ctx.volunteerEvent?._id,
  "festival-donations": ctx.festival?._id,
  "festival-showcases": ctx.showcase?._id,
  campaigners: ctx.campaigner?._id,
  users: ctx.admin,
  products: ctx.product?._id,
  orders: ctx.order?._id,
  preacher: ctx.donorWithDonations,
  media: fx.media,
  "hero-banners": fx.banner,
  "important-dates": fx.date,
  "contact-messages": fx.message,
};
const specificParams = (path) => {
  const m = {
    "/volunteers/admin/registrations/:id": { id: fx.volReg },
    "/campaigners/admin/:id/status": { id: ctx.campaigner?._id },
    "/temple-devotees/admin/:id": { id: fx.devotee },
  }[path];
  return m;
};
const variantsOf = (path) => {
  const seg = path.split("/")[1];
  const real = realIds[seg] ? String(realIds[seg]) : "000000000000000000000000";
  const slugFor = (p) =>
    p.startsWith("/festival-donations")
      ? fx.festivalSlug
      : p.startsWith("/festival-showcases")
        ? fx.showcaseSlug
        : p.startsWith("/campaigners")
          ? fx.campaignerSlug
          : fx.blogSlug;
  const fill = (id, word, special) =>
    path.replace(/:([A-Za-z]+)/g, (_, n) => {
      if (special?.[n]) return special[n];
      if (n === "token") return word === "nonsense" ? "nonsense" : (fx.reg?.token ?? word);
      return /slug|idOrSlug|orderNumber|secret|mobile|subscriptionId|orderId/i.test(n) ? word : id;
    });
  const special = specificParams(path);
  const eventId = ctx.event ? String(ctx.event._id) : real;
  return [
    ...new Set([
      fill(real, slugFor(path), special),
      fill("000000000000000000000000", "nonexistent", special && { id: "000000000000000000000000" }),
      fill("abc", "abc", special && { id: "abc" }),
    ]),
  ];
};

const QUERY_PARAMS = [
  "page",
  "limit",
  "skip",
  "offset",
  "search",
  "q",
  "status",
  "type",
  "category",
  "sort",
  "order",
  "from",
  "to",
  "startDate",
  "endDate",
  "minAmount",
  "maxAmount",
  "days",
  "featured",
  "mobile",
  "email",
  "slug",
  "tag",
  "festivalSlug",
  "sevaName",
  "source",
  "medium",
  "campaign",
  "export",
  "scope",
  "month",
  "year",
];
const QUERY_VALUES = [
  "",
  "0",
  "-1",
  "1",
  "2",
  "5",
  "100",
  "100000",
  "abc",
  "1e9",
  "NaN",
  "null",
  "undefined",
  "true",
  "false",
  ".*",
  "(",
  "[",
  "\\",
  "%",
  "a b",
  "é日本",
  "' OR 1=1 --",
  "<script>",
  "2026-01-01",
  "2026-13-45",
  "999999999999",
  "x".repeat(300),
];
const SKIP_FIELDS = new Set((opt("skip") ?? "").split(",").filter(Boolean)); // fields behind an intentional fix
const BODY_FIELDS = [
  "name",
  "title",
  "email",
  "mobile",
  "phone",
  "amount",
  "status",
  "type",
  "category",
  "date",
  "slug",
  "description",
  "message",
  "images",
  "tags",
  "active",
  "order",
  "featured",
  "role",
  "password",
  "content",
  "price",
  "stock",
  "quantity",
  "responses",
  "responses.x",
  "address",
  "pan",
  "panNumber",
  "donorName",
  "sevaName",
  "eventId",
  "url",
  "hero",
  "about",
  "contact",
  "navbar",
  "festival",
  "construction",
  "heroTitle",
  "donationOptions",
  "galleryImages",
  "impactItems",
  "bankDetails",
  "formFields",
  "schedule",
  "details",
  "testimonials",
  "gallery",
  "meta",
  "registrationForm",
  "endDate",
  "eventDate",
  "featuredOrder",
  "slots",
  "filledSlots",
  "preferences",
  "allowedModules",
  "tags",
  "excerpt",
  "devoteeId",
  "goalSqft",
  "campaignType",
  "dccEnrolledById",
  "adminResponse",
  "authorName",
  "coverImage",
  "linkUrl",
  "desktopImage",
  "mobileImage",
  "videoUrl",
];
const BODY_VALUES = [
  null,
  "",
  "  padded  ",
  0,
  -1,
  12345,
  "12",
  "abc",
  true,
  [],
  ["a"],
  {},
  { a: 1 },
  "x".repeat(2000),
  "<script>alert(1)</script>",
  ".*(",
  "2026-02-30",
  "UPPER lower",
  1.5,
  1e21,
  "2026-12-01T00:00:00.000Z",
  "https://youtu.be/dQw4w9WgXcQ",
  [{ id: "f1", label: "Phone", type: "tel" }],
  [{ title: "t", amount: "5", text: 7 }],
  { title: "Nested", junk: 1, customLink: { enabled: "yes", label: 5 } },
  ["x", 1, null],
  [null, {}],
  "  ",
  { _id: "abc" },
];

const reqFor = (base, r, path, q, body) => {
  const id = identity(r);
  return call(base, {
    method: r.method,
    path: path + (q ? (path.includes("?") ? "&" : "?") + q : ""),
    token: tokens[id],
    headers: id === "internal" ? { "x-internal-secret": "local-internal-secret" } : {},
    body,
  });
};
const BASE_BODY = (r) => bases[`${r.method} ${r.path}`] ?? {};

let total = 0,
  bad = 0,
  soft = 0;
const failures = new Map();
const compare = async (r, path, q, body, label) => {
  const [a, b] = [await reqFor(A, r, path, q, body), await reqFor(B, r, path, q, body)];
  total++;
  orderOnly.length = 0;
  const problems =
    a.status !== b.status
      ? [`status ${a.status} != ${b.status}`]
      : diff(normalize(maskGenerated(a.data)), normalize(maskGenerated(b.data)));
  if (orderOnly.length) soft++;
  if (problems.length) {
    bad++;
    const key = `${r.method} ${r.path}`;
    const list = failures.get(key) ?? failures.set(key, new Map()).get(key);
    const sig = problems[0]
      .replace(/"[^"]*"/g, '"~"')
      .replace(/\d+/g, "N")
      .slice(0, 110);
    const entry = list.get(sig);
    if (entry) entry.count++;
    else if (list.size < 10)
      list.set(sig, {
        count: 1,
        label,
        path,
        q,
        problems: problems.slice(0, 2),
        a: JSON.stringify(a.data)?.slice(0, 160),
        b: JSON.stringify(b.data)?.slice(0, 160),
        body: JSON.stringify(body)?.slice(0, 120),
      });
  }
};

for (const r of routes.filter((x) => !SKIP.test(x.path))) {
  for (const path of variantsOf(r.path)) {
    if (r.method === "GET") {
      await compare(r, path, "", undefined, "plain");
      for (const p of QUERY_PARAMS)
        for (const v of quick ? QUERY_VALUES.slice(0, 10) : QUERY_VALUES)
          await compare(r, path, `${p}=${encodeURIComponent(v)}`, undefined, `${p}=${v.slice(0, 30)}`);
      await compare(r, path, "status=a&status=b&page=1&page=2", undefined, "duplicates");
    } else if (r.method === "DELETE") {
      if (path.includes("000000000000000000000000") || path.includes("abc") || path.includes("nonexistent"))
        await compare(r, path, "", undefined, "plain");
    } else {
      const base = BASE_BODY(r);
      const unsafe =
        Object.keys(bases).length === 0 &&
        !path.includes("000000000000000000000000") &&
        !path.includes("abc") &&
        !path.includes("nonexistent") &&
        r.path.includes(":");
      if (unsafe) continue;
      await compare(r, path, "", base, "base");
      await compare(r, path, "", "{not json", "invalid json");
      await compare(r, path, "", [], "array body");
      for (const f of BODY_FIELDS.filter((x) => !SKIP_FIELDS.has(x)))
        for (const v of quick ? BODY_VALUES.slice(0, 8) : BODY_VALUES)
          await compare(r, path, "", { ...base, [f]: v }, `${f}=${JSON.stringify(v)?.slice(0, 30)}`);
    }
  }
}
console.log(`\nfuzz ${prefix}: ${total - bad}/${total} identical, ${soft} order-only`);
for (const [route, sigs] of failures) {
  const n = [...sigs.values()].reduce((x, e) => x + e.count, 0);
  console.log(`\nDIFF ${route}  (${n} variants, ${sigs.size} distinct)`);
  for (const f of sigs.values())
    console.log(`  x${f.count} ${f.label} body=${f.body} :: ${f.problems.join(" | ")}\n     A ${f.a}\n     B ${f.b}`);
}
process.exit(bad ? 1 : 0);
