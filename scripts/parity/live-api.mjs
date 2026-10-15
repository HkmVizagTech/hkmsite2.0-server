import { sign, discover, normalize, diff } from "./lib.mjs";

const LIVE = process.env.LIVE_API;
const LOCAL = process.env.LOCAL_API;
const { LIVE_EMAIL, LIVE_PASS } = process.env;
if (!LIVE || !LOCAL || !LIVE_EMAIL || !LIVE_PASS) throw new Error("set LIVE_API, LOCAL_API, LIVE_EMAIL, LIVE_PASS");

const loginRes = await fetch(`${LIVE}/users/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: LIVE_EMAIL, password: LIVE_PASS }) });
const login = await loginRes.json();
if (!login.token) throw new Error(`live login failed: ${loginRes.status} ${login.message ?? ""}`);
console.log("live login ok, role:", login.user?.role);

const liveGet = async (path) => {
  const r = await fetch(LIVE + path, { method: "GET", headers: { authorization: `Bearer ${login.token}` } });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => null) : await r.text() };
};
const ctx = await discover(process.env.SRC_MONGO_URI);
const localToken = sign({ userId: login.user._id, role: login.user.role });
const localGet = async (path) => {
  const r = await fetch(LOCAL + path, { headers: { authorization: `Bearer ${localToken}` } });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => null) : await r.text() };
};

const shape = (v, depth = 0) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 5 ? "[]" : v.length ? [shape(v[0], depth + 1)] : [];
  if (typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, depth > 5 ? "…" : shape(v[k], depth + 1)]));
  return typeof v;
};
const shapeKeys = (v, p = "$", out = new Set()) => {
  if (Array.isArray(v)) v.slice(0, 40).forEach((x) => shapeKeys(x, p + "[]", out));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { out.add(`${p}.${k}`); shapeKeys(v[k], `${p}.${k}`, out); }
  return out;
};

const firstDonation = (await liveGet("/donations?limit=1")).data?.donations?.[0]?._id;
const firstTxn = firstDonation;
const paths = [
  "/users/profile", "/users", "/dashboard/stats", "/devotees", "/devotees?limit=5&page=2",
  "/donations?limit=20", "/donations?status=completed&limit=20&page=2", "/donations?status=failed&limit=20", "/donations/stats", "/donations/utm-stats",
  "/donations/report", "/donations/whatsapp-audit", "/donations/needs-manual-receipt", "/donations/needs-whatsapp", "/donations/dcc-status",
  "/donations/prasadam-requests", "/donations/prasadam-export", "/donations/payment-failures", "/donations/upi-claims",
  firstDonation && `/donations/${firstDonation}`,
  "/donations-admin/dashboard-stats", "/donations-admin/report", "/donations-admin/transactions", "/donations-admin/transactions?status=completed&limit=15",
  firstTxn && `/donations-admin/transactions/${firstTxn}`, "/donations-admin/dcc-status", "/donations-admin/utm-stats", "/donations-admin/utm-transactions",
  "/donations-admin/prasadam-requests", "/donations-admin/prasadam-export",
  "/blogs", "/blogs/landing", "/blogs/categories", "/blogs/deletion-requests",
  "/campaigners/admin/list", "/contact-messages", "/festival-donations", "/festival-donations/all", "/festival-showcases", "/festival-showcases/public",
  "/temple-devotees/admin/list", "/temple-devotees", "/volunteers/admin/all", "/events", "/gallery", "/media", "/hero-banners", "/important-dates",
  "/site-content", "/donation-page", "/seva-stats", "/seva-stats/overview", "/darshan",
  "/shop-admin/products", "/shop-admin/categories", "/shop-admin/orders", "/shop-admin/settings", "/shop/products", "/shop/categories", "/shop/settings",
  "/preacher/my-donors", "/preacher/my-reports",
].filter(Boolean);

const rows = [];
for (const path of paths) {
  const [a, b] = [await liveGet(path), await localGet(path)];
  const sa = shapeKeys(a.data), sb = shapeKeys(b.data);
  const onlyLive = [...sa].filter((k) => !sb.has(k)), onlyLocal = [...sb].filter((k) => !sa.has(k));
  const same = a.status === b.status && JSON.stringify(normalize(a.data)) === JSON.stringify(normalize(b.data));
  const problems = same ? [] : a.status !== b.status ? [`status ${a.status} vs ${b.status}`] : diff(normalize(a.data), normalize(b.data));
  rows.push({ path, status: [a.status, b.status], same, shapeSame: onlyLive.length === 0 && onlyLocal.length === 0, onlyLive: onlyLive.slice(0, 4), onlyLocal: onlyLocal.slice(0, 4), problems: problems.slice(0, 3) });
  console.log(`${same ? "SAME " : rows.at(-1).shapeSame ? "VALUE" : "SHAPE"} ${a.status}/${b.status} ${path}`);
}
const fs = await import("node:fs");
fs.writeFileSync("/tmp/pw/live-api.json", JSON.stringify(rows, null, 1));
console.log(`\nendpoints: ${rows.length}; identical: ${rows.filter((r) => r.same).length}; same structure (keys): ${rows.filter((r) => r.shapeSame).length}; same status: ${rows.filter((r) => r.status[0] === r.status[1]).length}`);
