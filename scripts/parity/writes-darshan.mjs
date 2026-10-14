// /darshan/sync needs a transaction, which a standalone mongod cannot do. Run the baseline against a single-node
// replica set (mongod --replSet rs0 --port 27019 ... ; rs.initiate()) and point this script at it:
//   node scripts/parity/writes-darshan.mjs http://localhost:9212 http://localhost:9211
import { diff, normalize } from "./lib.mjs";

const [A, B] = process.argv.slice(2);
const SECRET = { "x-darshan-sync-secret": process.env.DARSHAN_SYNC_SECRET || "local-darshan-secret" };
const NOW = Date.now();
const mask = (v) => {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
  if (typeof v === "string") {
    if (/^[0-9a-f]{24}$/.test(v)) return "<id>";
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && Math.abs(Date.parse(v) - NOW) < 3600e3) return "<now>";
  }
  return v;
};
const call = async (base, { method = "GET", path, body, headers = {} }) => {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
};
const steps = [
  ["no secret", { method: "POST", path: "/darshan/sync", body: { photos: [] } }],
  [
    "wrong secret",
    { method: "POST", path: "/darshan/sync", body: { photos: [] }, headers: { "x-darshan-sync-secret": "nope" } },
  ],
  ["empty list", { path: "/darshan" }],
  [
    "sync 3",
    {
      method: "POST",
      path: "/darshan/sync",
      headers: SECRET,
      body: {
        photos: [
          { id: 1, imageUrl: "https://x/1.jpg", position: 5 },
          { id: "2", imageUrl: "https://x/2.jpg" },
          { id: 3, imageUrl: "https://x/3.jpg", position: "7" },
        ],
      },
    },
  ],
  ["list", { path: "/darshan" }],
  [
    "resync replace + skips",
    {
      method: "POST",
      path: "/darshan/sync",
      headers: SECRET,
      body: {
        photos: [
          { id: 2, imageUrl: "https://x/2b.jpg", position: 1 },
          { id: 9, imageUrl: "" },
          { id: "abc", imageUrl: "https://x/a.jpg" },
          { id: 4, imageUrl: "https://x/4.jpg" },
          { id: 4, imageUrl: "https://x/4b.jpg", position: 0 },
        ],
      },
    },
  ],
  ["list 2", { path: "/darshan" }],
  [
    "numeric imageUrl",
    { method: "POST", path: "/darshan/sync", headers: SECRET, body: { photos: [{ id: 5, imageUrl: 12345 }] } },
  ],
  ["list 3", { path: "/darshan" }],
  [
    "object imageUrl (rolls back)",
    {
      method: "POST",
      path: "/darshan/sync",
      headers: SECRET,
      body: {
        photos: [
          { id: 6, imageUrl: "https://x/6.jpg" },
          { id: 7, imageUrl: { a: 1 } },
        ],
      },
    },
  ],
  ["list 4 (unchanged)", { path: "/darshan" }],
  [
    "array imageUrl (rolls back)",
    { method: "POST", path: "/darshan/sync", headers: SECRET, body: { photos: [{ id: 8, imageUrl: ["x"] }] } },
  ],
  ["null photo entry", { method: "POST", path: "/darshan/sync", headers: SECRET, body: { photos: [null] } }],
  [
    "fractional id",
    {
      method: "POST",
      path: "/darshan/sync",
      headers: SECRET,
      body: { photos: [{ id: 1.5, imageUrl: "https://x/f.jpg", position: 2.5 }] },
    },
  ],
  ["list 5", { path: "/darshan" }],
  [
    "huge id",
    {
      method: "POST",
      path: "/darshan/sync",
      headers: SECRET,
      body: { photos: [{ id: 1e12, imageUrl: "https://x/h.jpg" }] },
    },
  ],
  ["photos not an array", { method: "POST", path: "/darshan/sync", headers: SECRET, body: { photos: "x" } }],
  ["list 6 (emptied)", { path: "/darshan" }],
  ["no body", { method: "POST", path: "/darshan/sync", headers: SECRET }],
  ["invalid json", { method: "POST", path: "/darshan/sync", headers: SECRET, body: "{bad" }],
];
let bad = 0;
for (const [name, req] of steps) {
  const [a, b] = [await call(A, req), await call(B, req)];
  const problems =
    a.status !== b.status
      ? [`status ${a.status} != ${b.status}`]
      : diff(normalize(mask(a.data)), normalize(mask(b.data)));
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name} [${a.status}/${b.status}]`);
  if (problems.length) {
    bad++;
    console.log(
      "   " +
        problems.join("\n   ") +
        `\n   A ${JSON.stringify(a.data)?.slice(0, 200)}\n   B ${JSON.stringify(b.data)?.slice(0, 200)}`
    );
  }
}
console.log(`\n${steps.length - bad}/${steps.length} identical`);
process.exit(bad ? 1 : 0);
