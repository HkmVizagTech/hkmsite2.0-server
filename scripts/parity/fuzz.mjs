import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
};
const variantsOf = (path) => {
  const seg = path.split("/")[1];
  const real = realIds[seg] ? String(realIds[seg]) : "000000000000000000000000";
  const fill = (id, word) =>
    path.replace(/:([A-Za-z]+)/g, (_, n) =>
      /slug|idOrSlug|orderNumber|token|secret|mobile|subscriptionId|orderId/i.test(n) ? word : id
    );
  return [
    ...new Set([
      fill(real, ctx.blog?.slug ?? "x"),
      fill("000000000000000000000000", "nonexistent"),
      fill("abc", "abc"),
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
    a.status !== b.status ? [`status ${a.status} != ${b.status}`] : diff(normalize(a.data), normalize(b.data));
  if (orderOnly.length) soft++;
  if (problems.length) {
    bad++;
    const key = `${r.method} ${r.path}`;
    const list = failures.get(key) ?? failures.set(key, []).get(key);
    if (list.length < 4)
      list.push({
        label,
        path,
        q,
        problems: problems.slice(0, 2),
        a: JSON.stringify(a.data)?.slice(0, 120),
        b: JSON.stringify(b.data)?.slice(0, 120),
      });
    else list.more = (list.more ?? 0) + 1;
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
      for (const f of BODY_FIELDS)
        for (const v of quick ? BODY_VALUES.slice(0, 8) : BODY_VALUES)
          await compare(r, path, "", { ...base, [f]: v }, `${f}=${JSON.stringify(v)?.slice(0, 30)}`);
    }
  }
}
console.log(`\nfuzz ${prefix}: ${total - bad}/${total} identical, ${soft} order-only`);
for (const [route, list] of failures) {
  console.log(`\nDIFF ${route}  (${list.length + (list.more ?? 0)} variants)`);
  for (const f of list) console.log(`  ${f.label} :: ${f.problems.join(" | ")}\n     A ${f.a}\n     B ${f.b}`);
}
process.exit(bad ? 1 : 0);
