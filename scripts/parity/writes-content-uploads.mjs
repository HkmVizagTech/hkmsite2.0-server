// Upload paths of the content slice (multipart + R2), replayed against the baseline and the new server.
// Needs the outbound fakes:  MOCKS=1 scripts/parity/env.sh up <name> <port>
//   SRC_MONGO_URI=... node scripts/parity/writes-content-uploads.mjs http://localhost:9214 http://localhost:9215
import { MongoClient } from "mongodb";
import { sign, diff, normalize } from "./lib.mjs";

const [A, B] = process.argv.slice(2);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const mdb = mongo.db();
const preIds = new Set();
for (const { name } of await mdb.listCollections().toArray())
  for (const d of await mdb
    .collection(name)
    .find({}, { projection: { _id: 1 } })
    .toArray())
    preIds.add(String(d._id));
const adminId = String((await mdb.collection("users").findOne({ role: "admin" }))._id);
const blogsAdminId = adminId;
const admin = sign({ userId: adminId, role: "admin" });
const blogsAdmin = sign({ userId: blogsAdminId, role: "blogs_admin" });
const NOW = Date.now();
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

const mask = (v) => {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
  if (typeof v === "string") {
    if (/^[0-9a-f]{24}$/.test(v) && !preIds.has(v)) return "<new-id>";
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && Math.abs(Date.parse(v) - NOW) < 3600e3) return "<now>";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return "<uuid>";
    return v.replace(/[0-9a-f]{24}/g, "<id>").replace(/\d{9,}/g, "<n>");
  }
  return v;
};

async function http(base, { method = "GET", path, token, json, files, fields = {} }) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  if (files || Object.keys(fields).length) {
    body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    for (const [field, name, type = "image/png"] of files || []) body.append(field, new Blob([PNG], { type }), name);
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const results = [];
const T = async (name, req, { keep } = {}) => {
  const [a, b] = [await http(A, req), await http(B, req)];
  const problems =
    a.status !== b.status
      ? [`status ${a.status} != ${b.status}`]
      : diff(normalize(mask(a.data)), normalize(mask(b.data)));
  results.push({ name, ok: problems.length === 0, problems, a: a.data, b: b.data, status: a.status });
  return { a, b };
};
const pair = async (name, build) => {
  // run on both servers with ids discovered per server
  const out = {};
  for (const [tag, base] of [
    ["a", A],
    ["b", B],
  ])
    out[tag] = await build(base);
  const problems = diff(normalize(mask(out.a.data)), normalize(mask(out.b.data)));
  const statusDiff = out.a.status !== out.b.status;
  results.push({
    name,
    ok: !statusDiff && problems.length === 0,
    problems: statusDiff ? [`status ${out.a.status} != ${out.b.status}`] : problems,
    a: out.a.data,
    b: out.b.data,
    status: out.a.status,
  });
  return out;
};

// gallery + inline blog image
await T("gallery upload-image", {
  method: "POST",
  path: "/gallery/upload-image",
  token: admin,
  files: [["file", "a.png"]],
});
await T("gallery upload-image none", {
  method: "POST",
  path: "/gallery/upload-image",
  token: admin,
  fields: { x: "1" },
});
await T("gallery upload-image non-image", {
  method: "POST",
  path: "/gallery/upload-image",
  token: admin,
  files: [["file", "a.txt", "text/plain"]],
});
await T("blog upload-inline", {
  method: "POST",
  path: "/blogs/upload-inline",
  token: blogsAdmin,
  files: [["upload", "inline.png"]],
});
await T("blog upload-inline none", {
  method: "POST",
  path: "/blogs/upload-inline",
  token: blogsAdmin,
  fields: { x: "1" },
});

// blogs create/update with files
const blogs = await pair("blog create multipart", (base) =>
  http(base, {
    method: "POST",
    path: "/blogs",
    token: blogsAdmin,
    fields: {
      title: "Upload Post",
      content: "<p>Body with upload that is long enough to pass.</p>",
      category: "Recipes",
      status: "published",
      tags: "a, b",
      authorName: "Uploader",
    },
    files: [
      ["coverImage", "cover.png"],
      ["authorAvatar", "me.png"],
      ["images", "extra1.png"],
      ["images", "extra2.png"],
    ],
  })
);
const ids = {};
for (const [tag, r] of Object.entries(blogs)) ids[tag] = r.data?.blog?._id;
const both = async (name, build) => {
  const out = {};
  for (const [tag, base] of [
    ["a", A],
    ["b", B],
  ])
    out[tag] = await build(base, tag);
  const problems =
    out.a.status !== out.b.status
      ? [`status ${out.a.status} != ${out.b.status}`]
      : diff(normalize(mask(out.a.data)), normalize(mask(out.b.data)));
  results.push({ name, ok: problems.length === 0, problems, a: out.a.data, b: out.b.data, status: out.a.status });
  return out;
};
await both("blog update multipart", (base, tag) =>
  http(base, {
    method: "PUT",
    path: `/blogs/${ids[tag]}`,
    token: blogsAdmin,
    fields: {
      title: "Upload Post 2",
      content: "<p>Edited body that is long enough to pass.</p>",
      slug: "upload-post-2",
      featured: "true",
    },
    files: [
      ["coverImage", "cover2.png"],
      ["images", "extra3.png"],
    ],
  })
);
await both("blog get after update", (base, tag) => http(base, { path: `/blogs/${ids[tag]}?preview=1` }));
await both("blog update multipart (no change)", (base, tag) =>
  http(base, {
    method: "PUT",
    path: `/blogs/${ids[tag]}`,
    token: blogsAdmin,
    fields: { title: "Upload Post 2", content: "<p>Edited body that is long enough to pass.</p>" },
  })
);

// events with images + registration with files
const events = await pair("event create multipart", (base) =>
  http(base, {
    method: "POST",
    path: "/events",
    token: admin,
    fields: {
      title: "Upload Event",
      description: "d",
      date: "2026-11-11",
      registrationForm: JSON.stringify({ fields: [{ name: "n" }] }),
    },
    files: [
      ["images", "e1.png"],
      ["images", "e2.png"],
    ],
  })
);
const evIds = { a: events.a.data?.event?._id, b: events.b.data?.event?._id };
await both("event update multipart", (base, tag) =>
  http(base, {
    method: "PUT",
    path: `/events/${evIds[tag]}`,
    token: admin,
    fields: {
      title: "Upload Event 2",
      description: "d",
      date: "2026-11-12",
      registrationForm: JSON.stringify({ x: 1 }),
    },
  })
);
await both("event register with files", (base, tag) =>
  http(base, {
    method: "POST",
    path: `/events/${evIds[tag]}/register`,
    fields: { name: "Reg Uploader", phone: "9" },
    files: [
      ["proof", "proof.png"],
      ["proof2", "proof2.png"],
    ],
  })
);
await both("event registrations list", (base, tag) =>
  http(base, { path: `/events/${evIds[tag]}/registrations`, token: admin })
);
await both("event get", (base, tag) => http(base, { path: `/events/${evIds[tag]}` }));

// hero banners
const banners = await pair("hero banner create multipart", (base) =>
  http(base, {
    method: "POST",
    path: "/hero-banners",
    token: admin,
    fields: { title: "Upload Banner", linkUrl: " /x " },
    files: [
      ["desktopImage", "d.png"],
      ["mobileImage", "m.png"],
    ],
  })
);
const bIds = { a: banners.a.data?.banner?._id, b: banners.b.data?.banner?._id };
await both("hero banner create one image", (base) =>
  http(base, {
    method: "POST",
    path: "/hero-banners",
    token: admin,
    fields: { title: "One" },
    files: [["desktopImage", "d.png"]],
  })
);
await both("hero banner update multipart", (base, tag) =>
  http(base, {
    method: "PUT",
    path: `/hero-banners/${bIds[tag]}`,
    token: admin,
    fields: { order: "7", active: "false" },
    files: [["mobileImage", "m2.png"]],
  })
);
await both("hero banner list all", (base) => http(base, { path: "/hero-banners?all=true" }));

// media library
const media = await pair("media upload", (base) =>
  http(base, {
    method: "POST",
    path: "/media",
    token: admin,
    fields: { name: " My Pic ", tags: " a b " },
    files: [
      ["files", "one.png"],
      ["files", "two.png"],
    ],
  })
);
const mIds = { a: media.a.data?.items?.map((i) => i._id), b: media.b.data?.items?.map((i) => i._id) };
await both("media upload none", (base) =>
  http(base, { method: "POST", path: "/media", token: admin, fields: { name: "x" } })
);
await both("media list q", (base) => http(base, { path: "/media?q=my%20pic", token: admin }));
await both("media update", (base, tag) =>
  http(base, { method: "PUT", path: `/media/${mIds[tag][0]}`, token: admin, json: { name: " Renamed ", tags: "t " } })
);
await both("media delete", (base, tag) =>
  http(base, { method: "DELETE", path: `/media/${mIds[tag][1]}`, token: admin })
);
await both("media list after", (base) => http(base, { path: "/media?q=renamed", token: admin }));

await mongo.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} [${r.status}]`);
for (const f of failed)
  console.log(
    `\nFAIL ${f.name}\n  ${f.problems.join("\n  ")}\n  A ${JSON.stringify(f.a)?.slice(0, 300)}\n  B ${JSON.stringify(f.b)?.slice(0, 300)}`
  );
console.log(`\n${results.length - failed.length}/${results.length} identical`);
process.exit(failed.length ? 1 : 0);
