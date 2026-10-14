import { readFileSync } from "node:fs";
import { sign, call, normalize, diff, discover, orderOnly } from "./lib.mjs";

const [A, B, routesFile = "/tmp/routes.json"] = process.argv.slice(2);
const routes = JSON.parse(readFileSync(routesFile, "utf8"));
const ZERO = "000000000000000000000000";
const ctx = await discover(process.env.SRC_MONGO_URI);
const admin = (base) => sign({ userId: ctx.admin, role: "admin" });

async function makeUser(base, role, modules = []) {
  const email = `matrix-${role}-${modules.length}-${Date.now()}@example.com`;
  const r = await call(base, {
    method: "POST",
    path: "/users/register",
    token: admin(base),
    body: { name: `Matrix ${role}`, email, password: "Matrix@12345", role, allowedModules: modules },
  });
  return r.data?.user?._id;
}
const ALL_MODULES = ["raise-receipt", "my-donors", "resend", "my-reports", "donor-assignment"];
const idsFor = async (base) => ({
  user: await makeUser(base, "user"),
  donations_admin: await makeUser(base, "donations_admin"),
  blogs_admin: await makeUser(base, "blogs_admin"),
  shop_admin: await makeUser(base, "shop_admin"),
  preacher_all: await makeUser(base, "preacher", ALL_MODULES),
  preacher_none: await makeUser(base, "preacher", []),
});
const [ia, ib] = [await idsFor(A), await idsFor(B)];
const tokenFor = (ids, kind) => {
  if (kind === "none") return undefined;
  if (kind === "admin") return sign({ userId: ctx.admin, role: "admin" });
  if (kind === "donor") return sign({ donorId: ctx.donorWithDonations, type: "donor" });
  if (kind === "internal") return undefined;
  const role = kind.startsWith("preacher") ? "preacher" : kind;
  return sign({ userId: ids[kind], role });
};
const kinds = [
  "none",
  "user",
  "admin",
  "donations_admin",
  "blogs_admin",
  "shop_admin",
  "preacher_all",
  "preacher_none",
  "donor",
  "internal",
];

const fill = (path) =>
  path.replace(/:([A-Za-z]+)/g, (_, n) =>
    /slug|idOrSlug|orderNumber|token|secret|mobile|subscriptionId|orderId/i.test(n) ? "nonexistent" : ZERO
  );
const skip = (r) =>
  /^\/health$/.test(r.path) || r.path.startsWith("/darshan/sync") || /\/users\/(login|logout)$/.test(r.path);

let total = 0,
  same = 0,
  soft = 0;
const bad = [];
for (const r of routes.filter((x) => !skip(x))) {
  const path = fill(r.path);
  const bodyMethod = ["POST", "PUT", "PATCH"].includes(r.method);
  for (const kind of kinds) {
    const headers = kind === "internal" ? { "x-internal-secret": "local-internal-secret" } : {};
    const send = (base, ids) =>
      call(base, { method: r.method, path, token: tokenFor(ids, kind), headers, body: bodyMethod ? {} : undefined });
    const [a, b] = [await send(A, ia), await send(B, ib)];
    total++;
    orderOnly.length = 0;
    const na = normalize(a.data),
      nb = normalize(b.data);
    const problems = a.status !== b.status ? [`status ${a.status} != ${b.status}`] : diff(na, nb);
    if (!problems.length) {
      same++;
      if (orderOnly.length) soft++;
    } else
      bad.push({
        route: `${r.method} ${r.path}`,
        kind,
        a: a.status,
        b: b.status,
        problems: problems.slice(0, 3),
        bodyA: JSON.stringify(a.data)?.slice(0, 110),
        bodyB: JSON.stringify(b.data)?.slice(0, 110),
      });
  }
}
console.log(`\nmatrix: ${same}/${total} identical (${routes.length} routes x ${kinds.length} identities)`);
const byRoute = new Map();
for (const f of bad) (byRoute.get(f.route) ?? byRoute.set(f.route, []).get(f.route)).push(f);
for (const [route, fs] of byRoute) {
  console.log(`\nDIFF ${route}  [${fs.map((f) => f.kind).join(",")}]`);
  const f = fs[0];
  console.log(`   ${f.kind}: ${f.problems.join(" | ")}\n   A: ${f.bodyA}\n   B: ${f.bodyB}`);
}
process.exit(bad.length ? 1 : 0);
