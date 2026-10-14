// Randomised differential test of src/domain/odm.js against Mongoose: create (incl. explicit undefined), update casting.
//   node scripts/parity/odm-diff.mjs [model|all] [seed] [trialsPerModel]
import { createRequire } from "node:module";
import util from "node:util";
const require = createRequire(import.meta.url);
const { models, connect, mongoose } = require("./odm-oracle.cjs");
const S = await import("../../src/domain/schemas.js");

const pairs = {
  blog: [models.blogModel, S.blogSchema],
  event: [models.eventModel, S.eventSchema],
  registration: [models.registrationModel, S.registrationSchema],
  gallery: [models.galleryModel, S.gallerySchema],
  heroBanner: [models.heroBannerModel, S.heroBannerSchema],
  importantDate: [models.importantDateModel, S.importantDateSchema],
  media: [models.mediaModel, S.mediaSchema],
  siteContent: [models.siteContentModel, S.siteContentSchema],
  donationPage: [models.donationPageModel, S.donationPageSchema],
  contactMessage: [models.contactMessageModel, S.contactMessageSchema],
  darshan: [models.darshanModel, S.darshanSchema],
  templeDevotee: [models.templeDevoteeModel, S.templeDevoteeSchema],
  volunteerEvent: [models.volunteerEventModel, S.volunteerEventSchema],
  volunteerRegistration: [models.volunteerRegistrationModel, S.volunteerRegistrationSchema],
  festivalShowcase: [models.festivalShowcaseModel, S.festivalShowcaseSchema],
  festivalDonation: [models.festivalDonationModel, S.festivalDonationSchema],
  campaigner: [models.campaignerModel, S.campaignerSchema],
  user: [models.userModel, S.userSchema],
  donorIssue: [models.donorIssueModel, S.donorIssueSchema],
};
let seed = Number(process.argv[3] || 1);
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const POOL = [
  null,
  "",
  " pad ",
  "abc",
  "UPPER Case",
  "12",
  "2026-01-01",
  "2026-13-45",
  "2026-02-30",
  0,
  -1,
  1.5,
  12345,
  1e21,
  true,
  false,
  "true",
  "yes",
  "no",
  [],
  ["a"],
  [1, null],
  [[1]],
  ["", "x"],
  {},
  { a: 1 },
  { _id: "x" },
  { id: "a", label: "b" },
  { id: 5, label: ["q"] },
  [{ id: "a", label: "b" }],
  [{ id: "a" }],
  [{}],
  [null, {}],
  ["abc"],
  "x".repeat(400),
  "6aca6af7ba02056969e76187",
  "abcdefghijkl",
  { toString: 1 },
  "draft",
  "published",
  "Krishna Katha",
  "upcoming",
  "active",
  "festival",
  "SQFT",
  "pending",
  "new",
  "Other",
  "text",
  "open",
  [{ id: "a", label: "b", type: "zz", options: [1] }],
  [{ rating: 9 }],
  [{ rating: "3", name: 4 }],
  100001,
  "  Mixed@Email.COM ",
];
const sortKeys = (o) =>
  Array.isArray(o)
    ? o.map(sortKeys)
    : o && typeof o === "object"
      ? Object.fromEntries(
          Object.keys(o)
            .sort()
            .map((k) => [k, sortKeys(o[k])])
        )
      : o;
const norm = (v) => sortKeys(JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x))));
const strip = (o) => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (!["_id", "createdAt", "updatedAt"].includes(k)) r[k] = strip(v);
    return r;
  }
  return o;
};
const pathsOf = (schema) => [...schema.schema.paths.keys(), ...schema.schema.nested];
const randNested = (schema, n) => {
  if (rnd() < 0.25) return pick(POOL);
  const subs = [...schema.schema.paths.keys()].filter((k) => k.startsWith(n + "."));
  const o = {};
  const k = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < k; i++) {
    const sp = pick(subs);
    const rel = sp.slice(n.length + 1);
    if (rel.includes(".")) {
      const [h, ...rest] = rel.split(".");
      o[h] = o[h] && typeof o[h] === "object" && !Array.isArray(o[h]) ? o[h] : {};
      o[h][rest.join(".")] = pick(POOL);
    } else o[rel] = pick(POOL);
  }
  if (rnd() < 0.2) o.junk = 1;
  return o;
};
const randBody = (schema, forUpdate = false) => {
  const keys = [...schema.schema.paths.keys()].filter(
    (k) => !k.includes(".") && !(forUpdate && schema.schema.paths.get(k).opts.meta)
  );
  const nest = [...schema.schema.nested].filter((k) => !k.includes("."));
  const body = {};
  const n = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    if (nest.length && rnd() < 0.25) {
      const nn = pick(nest);
      body[nn] = randNested(schema, nn);
    } else body[rnd() < 0.1 ? "unknownField" : pick(keys)] = pick(POOL);
  }
  return body;
};
const goodBase = {
  blog: { title: "t", content: "c", slug: "s" },
  event: { title: "t", description: "d", date: "2026-01-01" },
  registration: { eventId: "6aca6af7ba02056969e76187", token: "tok" },
  gallery: { title: "t", date: "2026-01-01", images: ["a"] },
  heroBanner: { title: "t", desktopImage: "a", mobileImage: "b" },
  importantDate: { title: "t", date: "2026-01-01" },
  media: { name: "n", url: "u", publicId: "p" },
  siteContent: { key: "t" },
  donationPage: { key: "d" },
  contactMessage: { name: "n", email: "e", message: "m" },
  darshan: { vaikunthamId: 1, imageUrl: "u" },
  templeDevotee: { name: "n" },
  volunteerEvent: { title: "t", description: "d", date: "2026-01-01" },
  volunteerRegistration: { eventId: "6aca6af7ba02056969e76187" },
  festivalShowcase: { title: "t", slug: "s" },
  festivalDonation: { title: "t", slug: "s" },
  campaigner: { name: "n", email: "e", mobile: "m", slug: "s" },
  user: { name: "n", email: "e", password: "p" },
  donorIssue: { donorRecordId: "6aca6af7ba02056969e76187", subject: "s", message: "m" },
};
await connect();
const only = process.argv[2];
const N = Number(process.argv[4] || 1500);
let totalBad = 0;
for (const [name, [M, schema]] of Object.entries(pairs)) {
  if (only && only !== "all" && only !== name) continue;
  let bad = 0;
  const shown = new Set();
  const report = (kind, body, a, b) => {
    bad++;
    totalBad++;
    const key = kind + String(a).slice(0, 60);
    if (shown.size < 6 && !shown.has(key)) {
      shown.add(key);
      console.log(
        `[${name}] ${kind} MISMATCH body=${util.inspect(body, { breakLength: 200, depth: 4 })}\n   oracle: ${util.inspect(a, { breakLength: 200, depth: 5 })}\n   mine:   ${util.inspect(b, { breakLength: 200, depth: 5 })}`
      );
    }
  };
  for (let i = 0; i < N; i++) {
    // create
    const body = { ...(rnd() < 0.5 ? goodBase[name] : {}), ...randBody(schema) };
    let oracle, mine;
    try {
      const d = new M(JSON.parse(JSON.stringify(body)));
      const e = d.validateSync();
      oracle = e ? "ERR " + e.message : strip(norm(d.toJSON()));
    } catch (e) {
      oracle = "THROW " + e.message;
    }
    try {
      mine = strip(norm(schema.create(JSON.parse(JSON.stringify(body)))));
    } catch (e) {
      mine = e.name === "ValidationError" ? "ERR " + e.message : "THROW " + e.message;
    }
    if (JSON.stringify(oracle) !== JSON.stringify(mine)) report("create", body, oracle, mine);
    // create with explicit undefined values (controllers destructure req.body into object literals)
    {
      const ubase = {};
      for (const k of Object.keys({ ...goodBase[name], ...randBody(schema) }))
        ubase[k] = rnd() < 0.5 ? undefined : (goodBase[name][k] ?? pick(POOL));
      let o3, m3;
      try {
        const d = new M(ubase);
        const e = d.validateSync();
        o3 = e ? "ERR " + e.message : strip(norm(d.toJSON()));
      } catch (e) {
        o3 = "THROW " + e.message;
      }
      try {
        m3 = strip(norm(schema.create(ubase)));
      } catch (e) {
        m3 = e.name === "ValidationError" ? "ERR " + e.message : "THROW " + e.message;
      }
      if (JSON.stringify(o3) !== JSON.stringify(m3))
        report(
          "create-undef",
          Object.fromEntries(Object.entries(ubase).map(([k, v]) => [k, v === undefined ? "<undefined>" : v])),
          o3,
          m3
        );
    }
    // update
    const ubody = randBody(schema, true);
    let base;
    try {
      base = await M.create(goodBase[name]);
    } catch (e) {
      continue;
    }
    let o2, m2;
    try {
      const r = await M.findByIdAndUpdate(base._id, JSON.parse(JSON.stringify(ubody)), { new: true });
      o2 = strip(norm(r.toJSON()));
    } catch (e) {
      o2 = "ERR " + e.name + ": " + e.message;
    }
    try {
      const patch = schema.castUpdate(JSON.parse(JSON.stringify(ubody)));
      m2 = strip(norm(patch));
    } catch (e) {
      m2 = "ERR " + e.name + ": " + e.message;
    }
    if (typeof o2 === "string" || typeof m2 === "string") {
      if (o2 !== m2) report("update", ubody, o2, m2);
    } else {
      const baseJ = strip(norm(base.toJSON()));
      const subset = (m, o) =>
        m && typeof m === "object" && !Array.isArray(m)
          ? o && typeof o === "object" && Object.entries(m).every(([k, v]) => subset(v, o[k]))
          : JSON.stringify(m) === JSON.stringify(o);
      for (const [k, v] of Object.entries(m2)) {
        if (!subset(v, o2[k])) {
          report("update", ubody, o2[k], { [k]: v });
          break;
        }
      }
      for (const k of Object.keys(o2)) {
        if (!(k in m2) && JSON.stringify(o2[k]) !== JSON.stringify(baseJ[k])) {
          report("update-extra", ubody, { [k]: o2[k] }, "not in patch");
          break;
        }
      }
    }
    if (i % 100 === 0) await M.deleteMany({});
  }
  console.log(`${name}: ${bad} mismatches / ${N}x2`);
}
await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
console.log("total mismatches", totalBad);
