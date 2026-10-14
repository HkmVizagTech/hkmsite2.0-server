// Randomised differential test of odm applySave (Object.assign + save) against Mongoose for blog and heroBanner.
//   node scripts/parity/odm-save.mjs
import { createRequire } from "node:module";
import util from "node:util";
const require = createRequire(import.meta.url);
const { models, connect, mongoose } = require("./odm-oracle.cjs");
const S = await import("../../src/domain/schemas.js");
const pairs = {
  blog: [models.blogModel, S.blogSchema, { title: "t", content: "c", slug: "s", excerpt: "e", tags: ["a"] }],
  heroBanner: [
    models.heroBannerModel,
    S.heroBannerSchema,
    { title: "t", desktopImage: "a", mobileImage: "b", order: 2 },
  ],
};
let seed = 5;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const POOL = [
  null,
  "",
  " pad ",
  "t",
  "c",
  "e",
  "abc",
  "UPPER",
  "12",
  2,
  0,
  -1,
  1.5,
  true,
  false,
  "true",
  [],
  ["a"],
  [1, null],
  ["a", "b"],
  {},
  "draft",
  "published",
  "Krishna Katha",
  "bad",
  "2026-01-01",
  "6aca6af7ba02056969e76187",
  "x".repeat(50),
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
const norm = (v) => sortKeys(JSON.parse(JSON.stringify(v)));
await connect();
let bad = 0;
for (const [name, [M, schema, base]] of Object.entries(pairs)) {
  const keys = [...schema.schema.paths.keys()].filter((k) => !k.includes(".") && !schema.schema.paths.get(k).opts.meta);
  for (let i = 0; i < 1500; i++) {
    const body = {};
    const n = 1 + Math.floor(rnd() * 4);
    for (let j = 0; j < n; j++) body[pick(keys)] = pick(POOL);
    if (name === "blog" && rnd() < 0.3)
      body.author = { name: pick(POOL), avatar: pick(POOL), bio: pick(POOL), slug: pick(POOL) };
    if (rnd() < 0.3) for (const k of Object.keys(body)) if (rnd() < 0.5) body[k] = norm(base)[k] ?? body[k];
    const d0 = await M.create(base);
    const before = norm((await M.findById(d0._id)).toJSON());
    const doc = await M.findById(d0._id);
    await new Promise((r) => setTimeout(r, 3));
    let o;
    try {
      Object.assign(doc, JSON.parse(JSON.stringify(body)));
      await doc.save();
      const after = norm((await M.findById(d0._id)).toJSON());
      o = { changed: after.updatedAt !== before.updatedAt, doc: { ...after, updatedAt: 0 } };
    } catch (e) {
      o = "ERR " + e.message;
    }
    let m;
    try {
      const r = schema.applySave(before, JSON.parse(JSON.stringify(body)));
      m = { changed: Object.keys(r.modified).length > 0, doc: { ...norm(r.doc), updatedAt: 0 } };
    } catch (e) {
      m = "ERR " + e.message;
    }
    if (typeof o !== "string") o.doc = schema.shape ? norm(o.doc) : o.doc;
    if (JSON.stringify(o) !== JSON.stringify(m)) {
      bad++;
      if (bad < 12)
        console.log(
          name,
          "MISMATCH",
          util.inspect(body, { breakLength: 200 }),
          "\n  oracle",
          util.inspect(o, { breakLength: 200, depth: 4 }),
          "\n  mine  ",
          util.inspect(m, { breakLength: 200, depth: 4 })
        );
    }
    await M.deleteMany({});
  }
}
console.log("save mismatches", bad);
await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
