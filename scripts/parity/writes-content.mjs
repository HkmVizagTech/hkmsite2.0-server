// Replays the same mutating requests against the Mongo baseline and the Postgres server,
// compares status codes and masked bodies step by step, then compares the resulting database state.
//   env.sh reset content
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/writes-content.mjs http://localhost:9200 http://localhost:9201
// Fix checks (whitelisting, HTML sanitizing, password hashes) run only against the new server.
import { MongoClient } from "mongodb";
import { sign, diff, normalize } from "./lib.mjs";
import { sanitizeBlogHtml } from "../../src/domain/blog.js";

const [A, B] = [process.argv[2], process.argv[3]];
const MONGO = process.env.SRC_MONGO_URI || "mongodb://127.0.0.1:27018/m_content";

const HEX = /^[0-9a-f]{24}$/i;
const TS_KEYS = /^(createdAt|updatedAt|publishedAt|deletionRequestedAt|respondedAt|syncedAt|at)$/;
const DROP_KEYS = new Set(["__v", "password", "token"]);

// ---- masking -------------------------------------------------------------------------------
const SUBDOC_KEYS = new Set(["donationOptions", "impactItems"]);
function masker(pre, numbered = true) {
  const ids = new Map();
  const mask = (v, key) => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) {
      if (SUBDOC_KEYS.has(key)) return v.map((x) => mask({ ...x, _id: x?._id && !pre.has(x._id) ? "<sub>" : x?._id }));
      return v.map((x) => mask(x));
    }
    if (typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (!DROP_KEYS.has(k)) out[k] = mask(x, k);
      return out;
    }
    if (typeof v === "string") {
      if (TS_KEYS.test(key || "") && !Number.isNaN(Date.parse(v))) return "<ts>";
      if (HEX.test(v) && !pre.has(v)) {
        if (!numbered) return "<new>";
        if (!ids.has(v)) ids.set(v, `<id${ids.size + 1}>`);
        return ids.get(v);
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return "<uuid>";
    }
    return v;
  };
  return mask;
}

// Legacy Mongo documents lack keys that Mongoose only defaulted on read; Postgres always has the
// column. Treat "missing" and "default value" as equal on both sides.
const DEFAULTS = { campaignType: "SQFT", donateEnabled: true, customLink: "", mustChangePassword: false };
const DEFAULT_PREFS = { newDonation: true, newDevotee: true, eventReminders: true }; // weeklyReport:false is stripped
const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
function stripDefaults(v) {
  if (Array.isArray(v)) return v.map((x) => stripDefaults(x));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const sx = stripDefaults(x);
      if (sx === false || sx === "" || (Array.isArray(sx) && !sx.length)) continue;
      if (k in DEFAULTS && sx === DEFAULTS[k]) continue;
      if (k === "preferences" && sortedJson(sx) === sortedJson(DEFAULT_PREFS)) continue;
      out[k] = sx;
    }
    return out;
  }
  return v;
}

// ---- HTTP ----------------------------------------------------------------------------------
async function http(base, { method = "GET", path, token, json, form, headers = {} }) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, v);
  }
  const res = await fetch(base + path, { method, headers: h, body });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// ---- run -----------------------------------------------------------------------------------
const mongo = new MongoClient(MONGO);
await mongo.connect();
const mdb = mongo.db();

const COLLECTIONS = {
  blogs: "blogs",
  events: "events",
  registrations: "registrations",
  galleries: "galleries",
  heroBanners: "herobanners",
  importantDates: "importantdates",
  media: "media",
  siteContent: "sitecontents",
  donationPages: "donationpages",
  contactMessages: "contactmessages",
  darshans: "darshans",
  festivalDonations: "festivaldonations",
  festivalShowcases: "festivalshowcases",
  templeDevotees: "templedevotees",
  campaigners: "campaigners",
  volunteerEvents: "volunteerevents",
  volunteerRegistrations: "volunteerregistrations",
  users: "users",
  donorIssues: "donorissues",
};
const preIds = new Set();
for (const { name: c } of await mdb.listCollections().toArray())
  for (const d of await mdb
    .collection(c)
    .find({}, { projection: { _id: 1 } })
    .toArray())
    preIds.add(String(d._id));
const adminId = String((await mdb.collection("users").findOne({ role: "admin" }))._id);
const admin = sign({ userId: adminId, role: "admin" });
const donationsAdmin = sign({ userId: adminId, role: "donations_admin" });
const firstMedia = await mdb.collection("media").findOne({}, { sort: { _id: 1 } });
const firstIssue = await mdb.collection("donorissues").findOne({}, { sort: { _id: 1 } });
const firstDevotee = await mdb.collection("templedevotees").findOne({ status: "active" }, { sort: { _id: 1 } });
const date = "2026-12-01T00:00:00.000Z";
const SECRET = { "x-darshan-sync-secret": process.env.DARSHAN_SYNC_SECRET || "local-darshan-secret" };

async function scenario(base) {
  const out = [];
  const S = {};
  const T = async (name, req) => {
    const r = await http(base, req);
    out.push({ name, ...r });
    return r.data;
  };

  // ---------- users (needed for blogs_admin / preacher tokens)
  await T("user register missing", { method: "POST", path: "/users/register", token: admin, json: { name: "x" } });
  await T("user register short pw", {
    method: "POST",
    path: "/users/register",
    token: admin,
    json: { name: "x", email: "short@t.io", password: "abc" },
  });
  const ub = await T("user register blogs_admin", {
    method: "POST",
    path: "/users/register",
    token: admin,
    json: { name: "Blogger", email: "blogger@parity.test", password: "password123", role: "blogs_admin" },
  });
  await T("user register duplicate", {
    method: "POST",
    path: "/users/register",
    token: admin,
    json: { name: "Blogger", email: "blogger@parity.test", password: "password123" },
  });
  const up = await T("user register preacher", {
    method: "POST",
    path: "/users/register",
    token: admin,
    json: {
      name: "Preacher",
      email: "preacher@parity.test",
      password: "password123",
      role: "preacher",
      allowedModules: ["my-donors", "bogus"],
    },
  });
  const up2 = await T("user register preacher no modules", {
    method: "POST",
    path: "/users/register",
    token: admin,
    json: { name: "Preacher2", email: "preacher2@parity.test", password: "password123", role: "preacher" },
  });
  await T("user register as non-admin forbidden", {
    method: "POST",
    path: "/users/register",
    json: { name: "x", email: "z@z.io", password: "password123" },
  });
  await T("user register-admin bad confirm", {
    method: "POST",
    path: "/users/register-admin",
    token: admin,
    json: { name: "A2", email: "a2@parity.test", password: "password123", confirm: "no" },
  });
  await T("user register-admin", {
    method: "POST",
    path: "/users/register-admin",
    token: admin,
    json: { name: "A2", email: "a2@parity.test", password: "password123", confirm: "CREATE ADMIN" },
  });
  await T("login bad pw", {
    method: "POST",
    path: "/users/login",
    json: { email: "blogger@parity.test", password: "nope" },
  });
  await T("login non-string", { method: "POST", path: "/users/login", json: { email: { $ne: null }, password: "x" } });
  const lb = await T("login blogger", {
    method: "POST",
    path: "/users/login",
    json: { email: "blogger@parity.test", password: "password123" },
  });
  const lp = await T("login preacher", {
    method: "POST",
    path: "/users/login",
    json: { email: "preacher@parity.test", password: "password123" },
  });
  const lp2 = await T("login preacher2", {
    method: "POST",
    path: "/users/login",
    json: { email: "preacher2@parity.test", password: "password123" },
  });
  const blogger = lb.token,
    preacher = lp.token,
    preacher2 = lp2.token;
  S.userIds = [ub.user?._id, up.user?._id, up2.user?._id];
  await T("preacher module allowed", { path: "/preacher/my-donors", token: preacher });
  await T("preacher module denied", { path: "/preacher/my-donors", token: preacher2 });
  await T("profile", { path: "/users/profile", token: blogger });
  await T("profile no token", { path: "/users/profile" });
  await T("update profile prefs", {
    method: "PUT",
    path: "/users/update",
    token: blogger,
    json: { name: "Blogger 2", preferences: { weeklyReport: true } },
  });
  await T("update profile dup email", {
    method: "PUT",
    path: "/users/update",
    token: blogger,
    json: { email: "preacher@parity.test" },
  });
  await T("update profile pw no current", {
    method: "PUT",
    path: "/users/update",
    token: blogger,
    json: { newPassword: "newpassword1" },
  });
  await T("update profile pw wrong current", {
    method: "PUT",
    path: "/users/update",
    token: blogger,
    json: { newPassword: "newpassword1", currentPassword: "bad" },
  });
  await T("update profile pw", {
    method: "PUT",
    path: "/users/update",
    token: blogger,
    json: { newPassword: "newpassword1", currentPassword: "password123" },
  });
  await T("login new pw", {
    method: "POST",
    path: "/users/login",
    json: { email: "blogger@parity.test", password: "newpassword1" },
  });
  await T("change-password missing", { method: "PUT", path: "/users/change-password", token: blogger, json: {} });
  await T("change-password wrong", {
    method: "PUT",
    path: "/users/change-password",
    token: blogger,
    json: { currentPassword: "bad", newPassword: "another123" },
  });
  await T("change-password ok", {
    method: "PUT",
    path: "/users/change-password",
    token: blogger,
    json: { currentPassword: "newpassword1", newPassword: "another123" },
  });
  await T("login after change", {
    method: "POST",
    path: "/users/login",
    json: { email: "blogger@parity.test", password: "another123" },
  });
  await T("users list", { path: "/users", token: admin });

  // ---------- blogs
  const pad = "<p>padding text to satisfy the thirty character minimum</p>";
  const longContent = "<h2>Hello</h2><p>" + "word ".repeat(450) + "</p><ul><li>a</li></ul>";
  await T("blog create missing title", { method: "POST", path: "/blogs", token: admin, json: { content: "<p>x</p>" } });
  await T("blog create bad category", {
    method: "POST",
    path: "/blogs",
    token: admin,
    json: { title: "T", content: pad, category: "Nope" },
  });
  await T("blog create no auth", { method: "POST", path: "/blogs", json: { title: "T", content: "x" } });
  const b1 = await T("blog create published", {
    method: "POST",
    path: "/blogs",
    token: admin,
    json: {
      title: "Parity Post One!",
      excerpt: "short",
      content: longContent,
      category: "Krishna Katha",
      status: "published",
      tags: "a, b ,c",
      featured: "true",
      authorName: "Me",
    },
  });
  S.b1 = b1.blog?._id;
  await T("blog create same title (slug 2)", {
    method: "POST",
    path: "/blogs",
    token: admin,
    json: { title: "Parity Post One!", content: pad + "<p>two</p>", status: "published" },
  });
  const b3 = await T("blog create draft by blogs_admin", {
    method: "POST",
    path: "/blogs",
    token: blogger,
    json: { title: "Draft Zebra", content: pad + "<p>zebra quokka</p>", tags: JSON.stringify(["x", "y"]) },
  });
  S.b3 = b3.blog?._id;
  const bm = await T("blog create multipart", {
    method: "POST",
    path: "/blogs",
    token: admin,
    form: {
      title: "Multipart Post",
      content: pad + "<p>mp</p>",
      status: "draft",
      category: "Recipes",
      metaTitle: "mt",
    },
  });
  S.bm = bm.blog?._id;
  await T("blog list default", { path: "/blogs?limit=5" });
  await T("blog list q", { path: "/blogs?q=Parity" });
  await T("blog list q none", { path: "/blogs?q=zzzzqqqq" });
  await T("blog list status all", { path: "/blogs?status=all&limit=50" });
  await T("blog list drafts", { path: "/blogs?status=draft" });
  await T("blog list tag", { path: "/blogs?tag=b" });
  await T("blog list featured", { path: "/blogs?featured=true" });
  await T("blog list category", { path: "/blogs?category=Krishna%20Katha&limit=3&page=2" });
  await T("blog get draft hidden", { path: `/blogs/${S.b3}` });
  await T("blog get draft preview", { path: `/blogs/${S.b3}?preview=1` });
  await T("blog get by slug", { path: "/blogs/parity-post-one" });
  await T("blog get by slug again (views)", { path: "/blogs/parity-post-one" });
  await T("blog get missing", { path: "/blogs/no-such-slug" });
  await T("blog get after views", { path: "/blogs/parity-post-one" });
  await T("blog related", { path: `/blogs/${S.b1}/related` });
  await T("blog related missing", { path: "/blogs/000000000000000000000000/related" });
  await T("blog categories", { path: "/blogs/categories" });
  await T("blog update 404", {
    method: "PUT",
    path: "/blogs/000000000000000000000000",
    token: admin,
    json: { title: "x", content: pad },
  });
  await T("blog publish draft", {
    method: "PUT",
    path: `/blogs/${S.b3}`,
    token: blogger,
    json: {
      title: "Draft Zebra",
      status: "published",
      content: pad + "<p>zebra quokka now longer text</p>",
      slug: "Draft Zebra Renamed",
      tags: "q",
    },
  });
  await T("blog update keep", {
    method: "PUT",
    path: `/blogs/${S.b1}`,
    token: admin,
    json: { title: "Parity Post One Edited", content: longContent, featured: false, category: "Recipes" },
  });
  await T("blog update bad status", {
    method: "PUT",
    path: `/blogs/${S.b1}`,
    token: admin,
    json: { title: "T", content: pad, status: "weird" },
  });
  await T("blog update slug collision", {
    method: "PUT",
    path: `/blogs/${S.b1}`,
    token: admin,
    json: { title: "Parity Post One Edited", content: longContent, slug: "draft-zebra-renamed" },
  });
  await T("blog landing", { path: "/blogs/landing" });
  await T("blog delete by blogs_admin (request)", { method: "DELETE", path: `/blogs/${S.b3}`, token: blogger });
  await T("blog delete request 404", { method: "DELETE", path: "/blogs/000000000000000000000000", token: blogger });
  await T("blog deletion-requests", { path: "/blogs/deletion-requests", token: admin });
  await T("blog deletion-requests forbidden", { path: "/blogs/deletion-requests", token: blogger });
  await T("blog reject deletion", { method: "POST", path: `/blogs/${S.b3}/reject-deletion`, token: admin });
  await T("blog approve w/o request", { method: "POST", path: `/blogs/${S.b3}/approve-deletion`, token: admin });
  await T("blog request again", { method: "DELETE", path: `/blogs/${S.b3}`, token: blogger });
  await T("blog approve", { method: "POST", path: `/blogs/${S.b3}/approve-deletion`, token: admin });
  await T("blog get deleted", { path: `/blogs/${S.b3}?preview=1` });
  await T("blog delete by admin", { method: "DELETE", path: `/blogs/${S.bm}`, token: admin });
  await T("blog delete 404", { method: "DELETE", path: `/blogs/${S.bm}`, token: admin });

  // ---------- events + registrations
  await T("event create missing", { method: "POST", path: "/events", token: admin, form: { title: "x" } });
  await T("event create bad status", {
    method: "POST",
    path: "/events",
    token: admin,
    form: { title: "x", description: "d", date, status: "bogus" },
  });
  const ev = await T("event create", {
    method: "POST",
    path: "/events",
    token: admin,
    form: {
      title: "Parity Event",
      description: "desc",
      date,
      category: "Fest",
      status: "upcoming",
      bannerImage: "https://img/x.jpg",
      registrationForm: JSON.stringify({ fields: [{ name: "name", label: "Name" }] }),
    },
  });
  S.ev = ev.event?._id;
  await T("event create no registrationForm", {
    method: "POST",
    path: "/events",
    token: admin,
    form: { title: "Plain Event", description: "d2", date: "2026-11-01" },
  });
  await T("event get", { path: `/events/${S.ev}` });
  await T("event update", {
    method: "PUT",
    path: `/events/${S.ev}`,
    token: admin,
    form: { title: "Parity Event 2", status: "completed", registrationForm: JSON.stringify({ fields: [] }) },
  });
  await T("event update 404", {
    method: "PUT",
    path: "/events/000000000000000000000000",
    token: admin,
    form: { title: "x" },
  });
  await T("event list", { path: "/events" });
  await T("register 404", { method: "POST", path: "/events/000000000000000000000000/register", form: { name: "x" } });
  const r1 = await T("register 1", {
    method: "POST",
    path: `/events/${S.ev}/register`,
    form: { name: "Alice Parity", email: "a@x.io" },
  });
  const r2 = await T("register 2", {
    method: "POST",
    path: `/events/${S.ev}/register`,
    form: { name: "Bob Parity", email: "b@x.io" },
  });
  S.tok1 = r1.token;
  S.tok2 = r2.token;
  await T("registrations list", { path: `/events/${S.ev}/registrations`, token: admin });
  await T("registrations list q", { path: `/events/${S.ev}/registrations?q=alice`, token: admin });
  await T("registrations list paged", { path: `/events/${S.ev}/registrations?limit=1&page=2`, token: admin });
  await T("attendance", { method: "POST", path: `/events/${S.ev}/registrations/${S.tok1}/attendance`, token: admin });
  await T("attendance 404", { method: "POST", path: `/events/${S.ev}/registrations/nope/attendance`, token: admin });
  await T("checkin", { method: "POST", path: `/events/${S.ev}/checkin/${S.tok2}` });
  await T("checkin 404", { method: "POST", path: `/events/${S.ev}/checkin/nope` });
  await T("registrations attended=true", { path: `/events/${S.ev}/registrations?attended=true`, token: admin });
  await T("registrations paid=true", { path: `/events/${S.ev}/registrations?paid=true`, token: admin });
  const ev2 = await T("event create for delete", {
    method: "POST",
    path: "/events",
    token: admin,
    form: { title: "Delete me", description: "d", date },
  });
  await T("event delete", { method: "DELETE", path: `/events/${ev2.event?._id}`, token: admin });
  await T("event delete again", { method: "DELETE", path: `/events/${ev2.event?._id}`, token: admin });

  // ---------- gallery
  await T("gallery create missing", { method: "POST", path: "/gallery", token: admin, json: { title: "x" } });
  await T("gallery create bad type", {
    method: "POST",
    path: "/gallery",
    token: admin,
    json: { title: "x", date, type: "nope" },
  });
  const g = await T("gallery create", {
    method: "POST",
    path: "/gallery",
    token: admin,
    json: {
      title: "Parity Gallery",
      description: "d",
      images: ["https://i/1.jpg", "https://i/2.jpg"],
      date: "2026-10-20T05:00:00.000Z",
      category: "Daily Darshan",
      type: "festival",
    },
  });
  S.g = g.item?._id;
  await T("gallery create defaults", {
    method: "POST",
    path: "/gallery",
    token: admin,
    json: { title: "Parity Gallery 2", date: "2026-10-21", images: [] },
  });
  await T("gallery list", { path: "/gallery" });
  await T("gallery list filters", { path: "/gallery?type=festival&category=Daily%20Darshan&status=active" });
  await T("gallery list date", { path: "/gallery?date=2026-10-20" });
  await T("gallery get", { path: `/gallery/${S.g}` });
  await T("gallery update", {
    method: "PUT",
    path: `/gallery/${S.g}`,
    token: admin,
    json: { title: "Parity Gallery X", status: "inactive", images: ["https://i/3.jpg"] },
  });
  await T("gallery update 404", {
    method: "PUT",
    path: "/gallery/000000000000000000000000",
    token: admin,
    json: { title: "x" },
  });
  await T("gallery delete", { method: "DELETE", path: `/gallery/${S.g}`, token: admin });
  await T("gallery get deleted", { path: `/gallery/${S.g}` });

  // ---------- hero banners
  await T("banner create missing images", {
    method: "POST",
    path: "/hero-banners",
    token: admin,
    json: { title: "x" },
  });
  const hb1 = await T("banner create", {
    method: "POST",
    path: "/hero-banners",
    token: admin,
    json: { title: "Parity Banner", desktopImage: "https://i/d.jpg", mobileImage: "https://i/m.jpg", linkUrl: " /go " },
  });
  const hb2 = await T("banner create default title", {
    method: "POST",
    path: "/hero-banners",
    token: admin,
    json: { desktopImage: "https://i/d2.jpg", mobileImage: "https://i/m2.jpg", order: "9" },
  });
  S.hb1 = hb1.banner?._id;
  S.hb2 = hb2.banner?._id;
  await T("banner update", {
    method: "PUT",
    path: `/hero-banners/${S.hb1}`,
    token: admin,
    json: { active: "false", order: "5", title: " Renamed " },
  });
  await T("banner update 404", {
    method: "PUT",
    path: "/hero-banners/000000000000000000000000",
    token: admin,
    json: { title: "x" },
  });
  await T("banner reorder bad", { method: "PUT", path: "/hero-banners/reorder", token: admin, json: { order: "x" } });
  await T("banner reorder", {
    method: "PUT",
    path: "/hero-banners/reorder",
    token: admin,
    json: {
      order: [
        { id: S.hb1, order: 1 },
        { id: S.hb2, order: 0 },
      ],
    },
  });
  await T("banner list", { path: "/hero-banners" });
  await T("banner list all", { path: "/hero-banners?all=true" });
  await T("banner delete", { method: "DELETE", path: `/hero-banners/${S.hb2}`, token: admin });
  await T("banner delete 404", { method: "DELETE", path: `/hero-banners/${S.hb2}`, token: admin });

  // ---------- important dates
  await T("date create invalid", {
    method: "POST",
    path: "/important-dates",
    token: admin,
    json: { title: "x", date, type: "Bad" },
  });
  const d1 = await T("date create", {
    method: "POST",
    path: "/important-dates",
    token: admin,
    json: { title: "Parity Ekadashi", date: "2026-11-20", description: "desc", type: "Ekadashi" },
  });
  await T("date create default type", {
    method: "POST",
    path: "/important-dates",
    token: admin,
    json: { title: "Parity Other", date: "2026-11-21" },
  });
  S.d1 = d1.date?._id;
  await T("date get", { path: `/important-dates/${S.d1}` });
  await T("date update", {
    method: "PUT",
    path: `/important-dates/${S.d1}`,
    token: admin,
    json: { title: "Parity Ekadashi 2", type: "Festival" },
  });
  await T("date update 404", {
    method: "PUT",
    path: "/important-dates/000000000000000000000000",
    token: admin,
    json: { title: "x" },
  });
  await T("date list", { path: "/important-dates" });
  await T("date delete", { method: "DELETE", path: `/important-dates/${S.d1}`, token: admin });
  await T("date delete 404", { method: "DELETE", path: `/important-dates/${S.d1}`, token: admin });

  // ---------- media (existing record; uploads need R2)
  if (firstMedia) {
    const mid = String(firstMedia._id);
    await T("media list q", {
      path: `/media?q=${encodeURIComponent(String(firstMedia.name).slice(0, 4))}&limit=5`,
      token: admin,
    });
    await T("media list paged", { path: "/media?limit=2&page=2", token: admin });
    await T("media update", {
      method: "PUT",
      path: `/media/${mid}`,
      token: admin,
      json: { name: "  Renamed media ", tags: " t1 t2 " },
    });
    await T("media update 404", {
      method: "PUT",
      path: "/media/000000000000000000000000",
      token: admin,
      json: { name: "x" },
    });
    await T("media delete", { method: "DELETE", path: `/media/${mid}`, token: admin });
    await T("media delete 404", { method: "DELETE", path: `/media/${mid}`, token: admin });
  }
  await T("media upload none", { method: "POST", path: "/media", token: admin, form: { name: "x" } });

  // ---------- site content
  await T("site-content get", { path: "/site-content" });
  await T("site-content bad youtube", {
    method: "PUT",
    path: "/site-content",
    token: admin,
    json: { construction: { videoUrl: "https://example.com/x" } },
  });
  await T("site-content update sections", {
    method: "PUT",
    path: "/site-content",
    token: admin,
    json: {
      hero: { title: "New Title", junk: "x" },
      about: { heading: "H", body: "B" },
      navbar: { majorFestival: "none", customLink: { enabled: "true", label: "L", href: "/h" } },
    },
  });
  await T("site-content update construction", {
    method: "PUT",
    path: "/site-content",
    token: admin,
    json: {
      construction: {
        videoUrl: "https://youtube.com/shorts/abcdefghijk",
        photos: [{ url: " /a.jpg ", caption: "c".repeat(100) }, { url: "" }, { url: "/b.jpg" }],
      },
    },
  });
  await T("site-content video only keeps photos", {
    method: "PUT",
    path: "/site-content",
    token: admin,
    json: { construction: { videoUrl: "" } },
  });
  await T("site-content contact+festival", {
    method: "PUT",
    path: "/site-content",
    token: admin,
    json: { contact: { phone: "123" }, festival: { bannerDesktop: "/d.webp" } },
  });
  await T("site-content forbidden", {
    method: "PUT",
    path: "/site-content",
    token: blogger,
    json: { hero: { title: "x" } },
  });
  await T("site-content get after", { path: "/site-content" });

  // ---------- donation page
  await T("donation-page forbidden", {
    method: "PUT",
    path: "/donation-page",
    token: blogger,
    json: { heroTitle: "x" },
  });
  await T("donation-page update", {
    method: "PUT",
    path: "/donation-page",
    token: donationsAdmin,
    json: {
      heroTitle: "Parity Hero",
      bankDetails: { bankName: "B", extra: "x" },
      donationOptions: [
        { id: "1", category: "A", title: "T", amount: 100, junk: 1 },
        { id: 2, category: "B", title: "Any", amount: null },
      ],
      galleryImages: ["/g1.png"],
      impactItems: [{ title: "t", text: "x", junk: 1 }],
      contact: { phone: "1" },
      key: "hack",
      other: "ignored",
    },
  });
  await T("donation-page get", { path: "/donation-page" });
  await T("donation-page second update", {
    method: "PUT",
    path: "/donation-page",
    token: admin,
    json: { heroSubtitle: "Sub" },
  });
  await T("donation-page get 2", { path: "/donation-page" });

  // ---------- contact messages
  await T("contact missing", { method: "POST", path: "/contact-messages", json: { name: "x" } });
  const c1 = await T("contact create", {
    method: "POST",
    path: "/contact-messages",
    json: {
      name: " Parity Person ",
      email: " UPPER@Case.IO ",
      phone: " 99 ",
      message: " Hello ",
      authorization: "true",
    },
  });
  await T("contact create minimal", {
    method: "POST",
    path: "/contact-messages",
    json: { name: "Min", email: "m@x.io", message: "m" },
  });
  S.c1 = c1.id;
  await T("contact list", { path: "/contact-messages?limit=5", token: admin });
  await T("contact list status", { path: "/contact-messages?status=new&limit=3&page=2", token: admin });
  await T("contact status invalid", {
    method: "PUT",
    path: `/contact-messages/${S.c1}/status`,
    token: admin,
    json: { status: "bogus" },
  });
  await T("contact status", {
    method: "PUT",
    path: `/contact-messages/${S.c1}/status`,
    token: admin,
    json: { status: "read" },
  });
  await T("contact status 404", {
    method: "PUT",
    path: "/contact-messages/000000000000000000000000/status",
    token: admin,
    json: { status: "read" },
  });
  await T("contact delete", { method: "DELETE", path: `/contact-messages/${S.c1}`, token: admin });
  await T("contact delete 404", { method: "DELETE", path: `/contact-messages/${S.c1}`, token: admin });

  // ---------- darshan
  await T("darshan sync unauthorized", { method: "POST", path: "/darshan/sync", json: { photos: [] } });
  await T("darshan sync", {
    method: "POST",
    path: "/darshan/sync",
    headers: SECRET,
    json: {
      photos: [
        { id: 9001, imageUrl: "https://i/9001.jpg", position: 2 },
        { id: 9002, imageUrl: "https://i/9002.jpg" },
        { id: "x", imageUrl: "y" },
        { id: 9003 },
      ],
    },
  });
  await T("darshan list", { path: "/darshan" });
  await T("darshan resync", {
    method: "POST",
    path: "/darshan/sync",
    headers: SECRET,
    json: {
      photos: [
        { id: 9002, imageUrl: "https://i/new.jpg", position: 0 },
        { id: 9001, imageUrl: "https://i/9001.jpg", position: 1 },
      ],
    },
  });
  await T("darshan list 2", { path: "/darshan" });

  // ---------- temple devotees + campaigners
  await T("devotee create short", {
    method: "POST",
    path: "/temple-devotees/admin",
    token: admin,
    json: { name: "x" },
  });
  await T("devotee create bad dcc", {
    method: "POST",
    path: "/temple-devotees/admin",
    token: admin,
    json: { name: "Parity Dev", dccEnrolledById: "abc" },
  });
  const td = await T("devotee create", {
    method: "POST",
    path: "/temple-devotees/admin",
    token: admin,
    json: { name: "Parity Devotee", dccEnrolledById: "77" },
  });
  const td2 = await T("devotee create no dcc", {
    method: "POST",
    path: "/temple-devotees/admin",
    token: admin,
    json: { name: "  aaa Lower first  " },
  });
  S.td = td.devotee?._id;
  S.td2 = td2.devotee?._id;
  await T("devotee update", {
    method: "PUT",
    path: `/temple-devotees/admin/${S.td}`,
    token: admin,
    json: { name: "Parity Devotee 2", status: "weird", dccEnrolledById: "" },
  });
  await T("devotee update 404", {
    method: "PUT",
    path: "/temple-devotees/admin/000000000000000000000000",
    token: admin,
    json: { name: "abc" },
  });
  await T("devotee update hidden", {
    method: "PUT",
    path: `/temple-devotees/admin/${S.td2}`,
    token: admin,
    json: { status: "hidden" },
  });
  await T("devotees public", { path: "/temple-devotees" });
  await T("devotees admin", { path: "/temple-devotees/admin/list", token: admin });
  const campBody = {
    name: "Parity Camp",
    email: "Camp@Parity.io",
    mobile: "9999999999",
    goalSqft: 12.7,
    message: "hi",
    campaignType: "SQFT",
    devoteeId: S.td,
  };
  await T("campaigner register no devotee", {
    method: "POST",
    path: "/campaigners/register",
    json: { ...campBody, devoteeId: "" },
  });
  await T("campaigner register bad devotee", {
    method: "POST",
    path: "/campaigners/register",
    json: { ...campBody, devoteeId: S.td2 },
  });
  await T("campaigner register bad email", {
    method: "POST",
    path: "/campaigners/register",
    json: { ...campBody, email: "bad" },
  });
  await T("campaigner register bad mobile", {
    method: "POST",
    path: "/campaigners/register",
    json: { ...campBody, mobile: "x" },
  });
  await T("campaigner register", { method: "POST", path: "/campaigners/register", json: campBody });
  await T("campaigner register again", { method: "POST", path: "/campaigners/register", json: campBody });
  await T("campaigner register same name other type", {
    method: "POST",
    path: "/campaigners/register",
    json: { ...campBody, campaignType: "JANMASHTAMI", goalSqft: 999999 },
  });
  await T("campaigner public pending", { path: "/campaigners/parity-camp" });
  const cl = await T("campaigner admin list", { path: "/campaigners/admin/list", token: admin });
  const cid = cl.campaigners?.find((c) => c.slug === "parity-camp")?._id;
  S.cid = cid;
  await T("campaigner activate", {
    method: "PUT",
    path: `/campaigners/admin/${cid}/status`,
    token: admin,
    json: { status: "active" },
  });
  await T("campaigner public active", { path: "/campaigners/parity-camp" });
  await T("campaigner status 404", {
    method: "PUT",
    path: "/campaigners/admin/000000000000000000000000/status",
    token: admin,
    json: { status: "active" },
  });
  await T("campaigner hide", {
    method: "PUT",
    path: `/campaigners/admin/${cid}/status`,
    token: admin,
    json: { status: "hidden" },
  });
  await T("campaigner public hidden", { path: "/campaigners/parity-camp" });

  // ---------- volunteers
  await T("volunteer create missing", {
    method: "POST",
    path: "/volunteers/admin",
    token: admin,
    json: { title: "x" },
  });
  const ve = await T("volunteer create", {
    method: "POST",
    path: "/volunteers/admin",
    token: admin,
    json: {
      title: "Parity Volunteers",
      description: "d",
      date,
      slots: 2,
      formFields: [
        { id: "email", type: "email", label: "Email", required: true },
        { id: "name", label: "Name", required: true, options: ["a"] },
        { id: "note", type: "textarea", label: "Note" },
      ],
    },
  });
  S.ve = ve.event?._id;
  await T("volunteer list active", { path: "/volunteers" });
  await T("volunteer get", { path: `/volunteers/${S.ve}` });
  await T("volunteer register no responses", { method: "POST", path: `/volunteers/${S.ve}/register`, json: {} });
  await T("volunteer register missing required", {
    method: "POST",
    path: `/volunteers/${S.ve}/register`,
    json: { responses: { email: "a@b.io" } },
  });
  const vr1 = await T("volunteer register", {
    method: "POST",
    path: `/volunteers/${S.ve}/register`,
    json: { responses: { email: "Vol@One.IO", name: "One" } },
  });
  await T("volunteer register duplicate", {
    method: "POST",
    path: `/volunteers/${S.ve}/register`,
    json: { responses: { email: "vol@one.io", name: "One" } },
  });
  const vr2 = await T("volunteer register 2", {
    method: "POST",
    path: `/volunteers/${S.ve}/register`,
    json: { responses: { email: "vol@two.io", name: "Two" } },
  });
  await T("volunteer register full", {
    method: "POST",
    path: `/volunteers/${S.ve}/register`,
    json: { responses: { email: "vol@three.io", name: "Three" } },
  });
  S.vr1 = vr1.registration?._id;
  S.vr2 = vr2.registration?._id;
  await T("volunteer get filled", { path: `/volunteers/${S.ve}` });
  await T("volunteer regs", { path: `/volunteers/admin/${S.ve}/registrations`, token: admin });
  await T("volunteer reg update no status", {
    method: "PUT",
    path: `/volunteers/admin/registrations/${S.vr1}`,
    token: admin,
    json: {},
  });
  await T("volunteer reg update", {
    method: "PUT",
    path: `/volunteers/admin/registrations/${S.vr1}`,
    token: admin,
    json: { status: "approved" },
  });
  await T("volunteer reg update 404", {
    method: "PUT",
    path: "/volunteers/admin/registrations/000000000000000000000000",
    token: admin,
    json: { status: "approved" },
  });
  await T("volunteer reg delete", { method: "DELETE", path: `/volunteers/admin/registrations/${S.vr2}`, token: admin });
  await T("volunteer reg delete 404", {
    method: "DELETE",
    path: `/volunteers/admin/registrations/${S.vr2}`,
    token: admin,
  });
  await T("volunteer update", {
    method: "PUT",
    path: `/volunteers/admin/${S.ve}`,
    token: admin,
    json: { title: "Parity Volunteers 2", status: "closed", slots: "5" },
  });
  await T("volunteer register closed", {
    method: "POST",
    path: `/volunteers/${S.ve}/register`,
    json: { responses: { email: "vol@z.io", name: "Z" } },
  });
  await T("volunteer update 404", {
    method: "PUT",
    path: "/volunteers/admin/000000000000000000000000",
    token: admin,
    json: { title: "x" },
  });
  await T("volunteer list all", { path: "/volunteers/admin/all", token: admin });
  await T("volunteer delete", { method: "DELETE", path: `/volunteers/admin/${S.ve}`, token: admin });
  await T("volunteer delete 404", { method: "DELETE", path: `/volunteers/admin/${S.ve}`, token: admin });

  // ---------- festival donations
  await T("fd create missing", { method: "POST", path: "/festival-donations", token: admin, json: { title: "x" } });
  const fd = await T("fd create", {
    method: "POST",
    path: "/festival-donations",
    token: admin,
    json: {
      title: "Parity Fest",
      slug: " parity-fest ",
      description: "d",
      images: ["/i.jpg"],
      donationOptions: [
        { label: "A", amount: "100", description: "x" },
        { label: "B", amount: 200 },
      ],
      meta: { eventDate: "2026-12-01" },
      eventId: S.ev,
    },
  });
  S.fd = fd.page?._id;
  await T("fd create duplicate", {
    method: "POST",
    path: "/festival-donations",
    token: admin,
    json: { title: "Parity Fest", slug: "parity-fest" },
  });
  await T("fd list", { path: "/festival-donations", token: admin });
  await T("fd by slug", { path: "/festival-donations/parity-fest" });
  await T("fd by slug 404", { path: "/festival-donations/nope-nope" });
  await T("fd public all", { path: "/festival-donations/all" });
  await T("fd update", {
    method: "PUT",
    path: `/festival-donations/${S.fd}`,
    token: admin,
    json: { title: "Parity Fest 2", active: false, slug: " parity-fest-2 " },
  });
  await T("fd update 404", {
    method: "PUT",
    path: "/festival-donations/000000000000000000000000",
    token: admin,
    json: { title: "x" },
  });
  await T("fd public all after", { path: "/festival-donations/all" });
  await T("fd delete", { method: "DELETE", path: `/festival-donations/${S.fd}`, token: admin });

  // ---------- festival showcases
  await T("fs create missing", { method: "POST", path: "/festival-showcases", token: admin, json: { title: "x" } });
  const fs1 = await T("fs create", {
    method: "POST",
    path: "/festival-showcases",
    token: admin,
    json: {
      title: "Parity Showcase",
      slug: "parity-showcase",
      subtitle: "s",
      eventDate: "2026-12-05T00:00:00.000Z",
      status: "upcoming",
      featured: true,
      featuredOrder: 3,
      gallery: ["/g.jpg"],
      schedule: [{ start: "6AM", title: "T", description: "d" }],
      details: [{ heading: "H", body: "B", image: "/i.jpg" }],
      testimonials: [{ name: "N", role: "R", message: "M", rating: 4, avatar: "/a.jpg" }],
      customLink: "/x",
    },
  });
  S.fs = fs1.page?._id;
  await T("fs create duplicate", {
    method: "POST",
    path: "/festival-showcases",
    token: admin,
    json: { title: "x", slug: "parity-showcase" },
  });
  await T("fs create no date", {
    method: "POST",
    path: "/festival-showcases",
    token: admin,
    json: { title: "Parity NoDate", slug: "parity-nodate", eventDate: "" },
  });
  await T("fs public", { path: "/festival-showcases/public" });
  await T("fs by slug", { path: "/festival-showcases/parity-showcase" });
  await T("fs admin list", { path: "/festival-showcases", token: admin });
  await T("fs update", {
    method: "PUT",
    path: `/festival-showcases/${S.fs}`,
    token: admin,
    json: { title: "Parity Showcase 2", active: false, featuredOrder: "1", testimonials: [] },
  });
  await T("fs update 404", {
    method: "PUT",
    path: "/festival-showcases/000000000000000000000000",
    token: admin,
    json: { title: "x" },
  });
  await T("fs by slug inactive", { path: "/festival-showcases/parity-showcase" });
  await T("fs delete", { method: "DELETE", path: `/festival-showcases/${S.fs}`, token: admin });

  // ---------- donor issues
  if (firstIssue) {
    await T("issues list", { path: "/donor-issues", token: admin });
    await T("issues list status", { path: "/donor-issues?status=open", token: admin });
    await T("issue respond", {
      method: "PUT",
      path: `/donor-issues/${firstIssue._id}`,
      token: admin,
      json: { adminResponse: "Handled", status: "resolved" },
    });
    await T("issue respond 404", {
      method: "PUT",
      path: "/donor-issues/000000000000000000000000",
      token: admin,
      json: { status: "resolved" },
    });
  }
  await T("devotees aggregate", { path: "/devotees?limit=5", token: admin });
  await T("devotees q", { path: "/devotees?q=a&status=patron", token: admin });

  // ---------- user delete (last)
  await T("user delete preacher2", { method: "DELETE", path: `/users/${S.userIds[2]}`, token: admin });
  await T("users list after delete", { path: "/users", token: admin });
  return out;
}

// ---- state snapshot --------------------------------------------------------------------------
async function mongoState() {
  const out = {};
  for (const [name, coll] of Object.entries(COLLECTIONS))
    out[name] = JSON.parse(JSON.stringify(await mdb.collection(coll).find({}).toArray()));
  return out;
}
async function pgState() {
  const tables = await import("../../src/db/tables.js");
  const repos = {
    blogs: tables.blogs,
    events: tables.events,
    registrations: tables.registrations,
    galleries: tables.galleries,
    heroBanners: tables.heroBanners,
    importantDates: tables.importantDates,
    media: tables.media,
    siteContent: tables.siteContent,
    donationPages: tables.donationPages,
    contactMessages: tables.contactMessages,
    darshans: tables.darshans,
    festivalDonations: tables.festivalDonations,
    festivalShowcases: tables.festivalShowcases,
    templeDevotees: tables.templeDevotees,
    campaigners: tables.campaigners,
    volunteerEvents: tables.volunteerEvents,
    volunteerRegistrations: tables.volunteerRegistrations,
    users: tables.users,
    donorIssues: tables.donorIssues,
  };
  const out = {};
  for (const [name, repo] of Object.entries(repos)) out[name] = JSON.parse(JSON.stringify(await repo.find({})));
  return out;
}

const sortKey = (d) => JSON.stringify([d.slug, d.title, d.email, d.name, d.token, d.vaikunthamId, d.key, d.subject]);
function prepState(state, mask, isBaseline) {
  const out = {};
  for (const [name, docs] of Object.entries(state)) {
    const list = docs.map((d) => {
      const doc = { ...d };
      if (isBaseline && name === "blogs" && typeof doc.content === "string" && !preIds.has(String(d._id)))
        doc.content = sanitizeBlogHtml(doc.content);
      return stripDefaults(normalize(mask(doc)));
    });
    list.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    out[name] = list;
  }
  return out;
}

// ---- main ------------------------------------------------------------------------------------
const maskA = masker(preIds),
  maskB = masker(preIds);
const resA = await scenario(A);
const resB = await scenario(B);

let bad = 0;
const known = [];
for (let i = 0; i < resA.length; i++) {
  const a = resA[i],
    b = resB[i];
  if (a.name.startsWith("darshan")) continue; // standalone Mongo has no transactions: baseline answers 500
  if (a.name.startsWith("blog") && a.data?.blog?.content) a.data.blog.content = sanitizeBlogHtml(a.data.blog.content);
  const da = stripDefaults(normalize(maskA(a.data))),
    db = stripDefaults(normalize(maskB(b.data)));
  const problems = a.status !== b.status ? [`status ${a.status} != ${b.status}`] : diff(da, db);
  if (problems.length) {
    bad++;
    console.log(`DIFF [${a.name}]\n   ${problems.join("\n   ")}`);
  }
}
console.log(`\nwrite steps: ${resA.length - bad}/${resA.length} identical`);

const sa = prepState(await mongoState(), masker(preIds, false), true);
const pgs = await pgState();
const sb = prepState(pgs, masker(preIds, false), false);
delete sa.darshans;
delete sb.darshans; // baseline cannot sync locally (see above)
let stateBad = 0;
for (const name of Object.keys(sa)) {
  const problems = diff(sa[name], sb[name]);
  if (problems.length) {
    stateBad++;
    console.log(
      `STATE DIFF ${name} (A ${sa[name].length} docs, B ${sb[name].length} docs)\n   ${problems.slice(0, 8).join("\n   ")}`
    );
  }
}
console.log(`state tables: ${Object.keys(sa).length - stateBad}/${Object.keys(sa).length} identical`);
{
  const ds = await http(B, { path: "/darshan" });
  const ids = ds.data.items.map((i) => i.vaikunthamId).join(",");
  console.log(
    ids === "9002,9001" ? "fix ok: darshan sync replaced set (new server)" : `FIX CHECK FAILED: darshan items ${ids}`
  );
  if (ids !== "9002,9001") stateBad++;
}

// ---- fix checks (new server only) ------------------------------------------------------------
let fixFail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) {
    fixFail++;
    console.log(`FIX CHECK FAILED: ${name} ${extra}`);
  } else console.log(`fix ok: ${name}`);
};
const pad = "<p>padding text to satisfy the thirty character minimum</p>";
const ZERO = "000000000000000000000000";
{
  const evc = await http(B, {
    method: "POST",
    path: "/festival-donations",
    token: admin,
    json: { title: "Fix FD", slug: "fix-fd" },
  });
  const fid = evc.data.page._id;
  const up = await http(B, {
    method: "PUT",
    path: `/festival-donations/${fid}`,
    token: admin,
    json: { _id: ZERO, createdAt: "2000-01-01T00:00:00Z", createdBy: ZERO, title: "Fix FD 2", bogus: 1 },
  });
  check(
    "festival-donations PUT ignores _id/createdAt/createdBy",
    up.status === 200 &&
      up.data.page._id === fid &&
      up.data.page.createdAt !== "2000-01-01T00:00:00.000Z" &&
      up.data.page.createdBy === adminId &&
      up.data.page.title === "Fix FD 2" &&
      !("bogus" in up.data.page),
    JSON.stringify(up.data).slice(0, 200)
  );

  const gc = await http(B, {
    method: "POST",
    path: "/gallery",
    token: admin,
    json: { title: "Fix G", date, images: [] },
  });
  const gu = await http(B, {
    method: "PUT",
    path: `/gallery/${gc.data.item._id}`,
    token: admin,
    json: { _id: ZERO, createdBy: ZERO, createdAt: "2000-01-01", title: "Fix G2" },
  });
  check(
    "gallery PUT whitelist",
    gu.status === 200 &&
      gu.data.item._id === gc.data.item._id &&
      gu.data.item.createdBy === adminId &&
      gu.data.item.title === "Fix G2",
    JSON.stringify(gu.data).slice(0, 200)
  );

  const sc = await http(B, {
    method: "POST",
    path: "/festival-showcases",
    token: admin,
    json: { title: "Fix S", slug: "fix-s", createdBy: ZERO, _id: ZERO, createdAt: "2000-01-01" },
  });
  check(
    "showcase POST ignores _id/createdBy",
    sc.status === 201 && sc.data.page._id !== ZERO && sc.data.page.createdBy === adminId,
    JSON.stringify(sc.data).slice(0, 200)
  );
  const su = await http(B, {
    method: "PUT",
    path: `/festival-showcases/${sc.data.page._id}`,
    token: admin,
    json: { _id: ZERO, createdBy: ZERO, createdAt: "2000-01-01", title: "Fix S2" },
  });
  check(
    "showcase PUT whitelist",
    su.status === 200 &&
      su.data.page._id === sc.data.page._id &&
      su.data.page.createdBy === adminId &&
      su.data.page.title === "Fix S2"
  );

  const ec = await http(B, {
    method: "POST",
    path: "/events",
    token: admin,
    form: { title: "Fix E", description: "d", date },
  });
  const eu = await http(B, {
    method: "PUT",
    path: `/events/${ec.data.event._id}`,
    token: admin,
    form: { _id: ZERO, createdBy: ZERO, createdAt: "2000-01-01", title: "Fix E2", description: "d", date },
  });
  check(
    "event PUT whitelist",
    eu.status === 200 &&
      eu.data.event._id === ec.data.event._id &&
      eu.data.event.createdBy === adminId &&
      eu.data.event.title === "Fix E2",
    JSON.stringify(eu.data).slice(0, 200)
  );

  const dc = await http(B, { method: "POST", path: "/important-dates", token: admin, json: { title: "Fix D", date } });
  const du = await http(B, {
    method: "PUT",
    path: `/important-dates/${dc.data.date._id}`,
    token: admin,
    json: { _id: ZERO, createdBy: ZERO, title: "Fix D2" },
  });
  check(
    "important-date PUT whitelist",
    du.status === 200 && du.data.date._id === dc.data.date._id && du.data.date.createdBy === adminId
  );

  const vc = await http(B, {
    method: "POST",
    path: "/volunteers/admin",
    token: admin,
    json: { title: "Fix V", description: "d", date },
  });
  const vu = await http(B, {
    method: "PUT",
    path: `/volunteers/admin/${vc.data.event._id}`,
    token: admin,
    json: { _id: ZERO, createdBy: ZERO, filledSlots: 99, title: "Fix V2" },
  });
  check(
    "volunteer PUT whitelist (filledSlots/createdBy)",
    vu.status === 200 &&
      vu.data.event.filledSlots === 0 &&
      vu.data.event.createdBy === adminId &&
      vu.data.event._id === vc.data.event._id
  );

  const dirty = [
    '<h2 class="x">Title</h2>',
    '<p style="text-align:center;color:red">centered</p>',
    "<script>alert(1)</script>",
    '<p onclick="evil()">click</p>',
    '<a href="javascript:alert(1)">bad</a>',
    '<a href="https://ok.example" target="_blank" rel="noopener">good</a>',
    '<img src="https://i/x.jpg" onerror="evil()" alt="a" class="image_resized" style="width:50%">',
    '<figure class="image image-style-side"><img src="https://i/y.jpg"><figcaption>cap</figcaption></figure>',
    '<figure class="table"><table><thead><tr><th>h</th></tr></thead><tbody><tr><td colspan="2" style="width:10px">d</td></tr></tbody></table></figure>',
    '<blockquote><p>q</p></blockquote><ol start="3"><li>x</li></ol>',
    '<figure class="media"><oembed url="https://www.youtube.com/watch?v=abc"></oembed></figure>',
    '<iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe>',
    '<iframe src="https://evil.example/x"></iframe>',
    '<p style="background:url(javascript:alert(1))">s</p>',
  ].join("");
  const bc = await http(B, {
    method: "POST",
    path: "/blogs",
    token: admin,
    json: { title: "Sanitize Check", content: dirty, status: "published" },
  });
  const html = bc.data.blog?.content || "";
  check("blog create removes <script>", !/<script|alert\(1\)<\/script/i.test(html));
  check("blog create removes event handlers", !/onclick|onerror/i.test(html));
  check("blog create removes javascript: urls", !/javascript:/i.test(html));
  check("blog create removes foreign iframe", !html.includes("evil.example"));
  check("blog create keeps youtube iframe", html.includes("youtube.com/embed/abc"));
  check("blog create keeps oembed", html.includes("<oembed"));
  check(
    "blog create keeps headings/lists/tables/figure/classes/styles/links",
    [
      '<h2 class="x">',
      '<ol start="3">',
      "<table>",
      'colspan="2"',
      "image image-style-side",
      "<figcaption>",
      "text-align:center",
      "width:50%",
      'target="_blank"',
      "<blockquote>",
    ].every((s) => html.includes(s)),
    html.slice(0, 300)
  );
  const bu = await http(B, {
    method: "PUT",
    path: `/blogs/${bc.data.blog._id}`,
    token: admin,
    json: {
      title: "Sanitize Check",
      content: "<p>new text long enough</p><script>x()</script><img src=x onerror=y()>",
    },
  });
  check(
    "blog update sanitizes",
    bu.status === 200 && !/script|onerror/.test(bu.data.blog.content) && bu.data.blog.readTime === 1,
    bu.data.blog?.content
  );
  const bd = await http(B, {
    method: "POST",
    path: "/blogs",
    token: admin,
    json: { title: "Sanitize Draft", content: pad },
  });
  check("blog draft has no publishedAt", bd.data.blog.status === "draft" && !bd.data.blog.publishedAt);
  const bp = await http(B, {
    method: "PUT",
    path: `/blogs/${bd.data.blog._id}`,
    token: admin,
    json: { title: "Sanitize Draft", content: pad, status: "published" },
  });
  check("blog publishedAt set on first publish", !!bp.data.blog.publishedAt);
  const stored = await http(B, { path: "/blogs/reading-the-bhagavad-gita-for-the-first-time-a-gentle-roadmap" });
  const raw = await mdb
    .collection("blogs")
    .findOne({ slug: "reading-the-bhagavad-gita-for-the-first-time-a-gentle-roadmap" });
  check("existing posts are not rewritten on read", stored.status === 200 && stored.data.blog.content === raw.content);

  const ul = await http(B, { path: "/users", token: admin });
  check("users list has no password", ul.status === 200 && ul.data.users.every((u) => !("password" in u)));
  const pr = await http(B, { path: "/users/profile", token: admin });
  check("profile has no password", pr.status === 200 && !("password" in pr.data.user));
  const up2 = await http(B, { method: "PUT", path: "/users/update", token: admin, json: { name: "Admin Same" } });
  check("update has no password", up2.status === 200 && !("password" in up2.data.user));
  const lg = await http(B, {
    method: "POST",
    path: "/users/login",
    json: { email: "blogger@parity.test", password: "another123" },
  });
  check("login response has no password", lg.status === 200 && !("password" in lg.data.user));
  const rg = await http(B, {
    method: "POST",
    path: "/users/register",
    token: admin,
    json: { name: "Fix", email: "fix@parity.test", password: "password123" },
  });
  check("register response has no password", rg.status === 201 && !("password" in rg.data.user));
}
console.log(`\nfix checks failed: ${fixFail}`);
await mongo.close();
process.exit(bad || stateBad || fixFail ? 1 : 0);
