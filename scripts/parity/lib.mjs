import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";

export const SECRET = process.env.JWT_SECRET || "local-test-jwt-secret";

export const sign = (payload) => jwt.sign(payload, SECRET, { expiresIn: "1d" });

export async function discover(mongoUri) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db();
  const id = (d) => (d ? String(d._id) : undefined);
  const first = (c, q = {}, sort = { _id: -1 }) => db.collection(c).find(q).sort(sort).limit(1).next();
  const ctx = {
    admin: id(await first("users", { role: "admin" })),
    donationsAdmin: id(await first("users", { role: "donations_admin" })),
    preacher: id(await first("users", { role: "preacher" })),
    blogsAdmin: id(await first("users", { role: "blogs_admin" })),
    shopAdmin: id(await first("users", { role: "shop_admin" })),
    donation: await first("donations", { status: "completed", receiptNumber: { $exists: true } }),
    prasadamDonation: await first("donations", { wantPrasadam: true, status: "completed" }),
    recurring: await first("donations", { isRecurring: true }),
    failed: await first("donations", { status: "failed" }),
    manual: await first("donations", { manualEntry: true }),
    donor: await first("donors", {}),
    blog: await first("blogs", { status: "published" }),
    product: await first("products", {}),
    order: await first("shoporders", {}),
    event: await first("events", {}),
    festival: await first("festivaldonations", {}),
    showcase: await first("festivalshowcases", {}),
    campaigner: await first("campaigners", {}),
    gallery: await first("galleries", {}),
    volunteerEvent: await first("volunteerevents", {}),
    preacherDonor: undefined,
  };
  const donorWithDonations = await db
    .collection("donations")
    .aggregate([
      { $match: { donorRecordId: { $ne: null }, status: "completed" } },
      { $group: { _id: "$donorRecordId", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ])
    .next();
  ctx.donorWithDonations = donorWithDonations ? String(donorWithDonations._id) : id(ctx.donor);
  ctx.donorMobile = (await db.collection("donors").findOne({ _id: donorWithDonations?._id }))?.mobile;
  await client.close();
  return ctx;
}

const IGNORE = new Set(["__v"]);
export function normalize(v) {
  if (v === undefined) return undefined;
  if (v === null) return process.env.LOOSE_NULLS === "1" ? undefined : null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => normalize(x) ?? null);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (IGNORE.has(k)) continue;
      const n = normalize(v[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }
  if (typeof v === "number") return Math.round(v * 1e6) / 1e6;
  if (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return new Date(v).toISOString();
  return v;
}

export async function call(base, { method = "GET", path, body, token, headers = {} }) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(base + path, { method, headers: h, body: payload, redirect: "manual" });
  } catch (e) {
    return { status: -1, data: `NETWORK ${e.cause?.code ?? e.message}` };
  }
  const type = res.headers.get("content-type") || "";
  let data;
  if (type.includes("json")) data = await res.json().catch(() => null);
  else if (type.includes("pdf") || type.includes("octet"))
    data = `[binary ${(await res.arrayBuffer()).byteLength} bytes]`;
  else data = await res.text();
  return { status: res.status, data };
}

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
export const orderOnly = [];

export function diff(a, b, path = "$", out = []) {
  if (out.length > 12) return out;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && canon(a) !== canon(b)) {
    if (canon([...a].map(canon).sort()) === canon([...b].map(canon).sort())) {
      orderOnly.push(path);
      return out;
    }
  }
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < 12; i++) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (a && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`${path}.${k}: missing in A (B=${JSON.stringify(b[k])?.slice(0, 60)})`);
      else if (!(k in b)) out.push(`${path}.${k}: missing in B (A=${JSON.stringify(a[k])?.slice(0, 60)})`);
      else diff(a[k], b[k], `${path}.${k}`, out);
    }
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}
