// Unit-level differential test: src/domain/shopSchema.js against the real Mongoose models of the baseline build
// (no database needed). Usage: node scripts/parity/shop-schema-oracle.mjs [iterations]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PRODUCT, CATEGORY, SETTINGS, buildDocument, castUpdate } from "../../src/domain/shopSchema.js";

const here = dirname(fileURLToPath(import.meta.url));
const baseline = resolve(here, "../../../.localdb/baseline/src/models/");
const require = createRequire(import.meta.url);
const { productModel } = require(`${baseline}/product.model.js`);
const { shopCategoryModel } = require(`${baseline}/shopCategory.model.js`);
const { shopSettingsModel } = require(`${baseline}/shopSettings.model.js`);

const N = Number(process.argv[2] || 3000);
let seed = Number(process.env.SEED || 12345);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const SCALARS = [null, "", "  pad  ", 0, -1, 1.5, -0.5, 1e21, "12", " 7 ", "abc", "1e3", "0x10", "Infinity", "-5", true, false, [], ["a"], [1, 2], {}, { a: 1 }, { _id: "idx" }, "x".repeat(30), 5, "active", "hidden", "draft", "6aaa64c9a669e4e9df6564b7", "123456789012", [null], [{}], [[1]], ["a", 5, true], 123456789];
const OIDS = ["6aaa64c9a669e4e9df6564b7", "6AAA64C9A669E4E9DF6564B7", "zz", "123456789012", null, 5, {}, ["6aaa64c9a669e4e9df6564b7"], { _id: "6aaa64c9a669e4e9df6564b7" }];
const subdoc = () => {
  const d = {};
  for (const f of ["label", "sku", "price", "mrp", "stock", "weightGrams", "_id", "extra"]) {
    if (rnd() < 0.55) d[f] = f === "_id" ? pick(OIDS) : pick(SCALARS);
  }
  if (rnd() < 0.6) {
    d.label ??= "a";
    d.price ??= 1;
  }
  return d;
};
const variantsVal = () => {
  const r = rnd();
  if (r < 0.1) return pick(SCALARS.concat([0, "", false]));
  const n = Math.floor(rnd() * 3);
  return Array.from({ length: n }, () => (rnd() < 0.1 ? pick([null, 5, "x", [], {}, 0, "", false, true]) : subdoc()));
};
const genFor = (schema, create) => {
  const doc = {};
  const names = schema.paths.map(([p]) => p);
  const count = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < count; i++) {
    const p = pick(names);
    doc[p] = p === "variants" ? variantsVal() : p === "createdBy" ? pick(OIDS) : pick(SCALARS);
  }
  if (create) {
    if (rnd() < 0.8) doc.name ??= "n";
    if (rnd() < 0.8) doc.slug ??= "s";
  }
  return doc;
};

const mask = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/[0-9a-f]{24}/g, (m) => (m === "6aaa64c9a669e4e9df6564b7" ? m : "<id>")));
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));

async function oracleCreate(Model, raw) {
  try {
    const d = new Model(raw);
    await d.validate();
    const j = d.toJSON();
    delete j._id;
    return { doc: mask(j) };
  } catch (e) {
    return { error: e.message };
  }
}
function oracleUpdate(Model, raw) {
  try {
    const q = Model.findByIdAndUpdate("6aaa64c9a669e4e9df6564b7", raw, { new: true });
    const u = q._castUpdate(q._update);
    const set = { ...(u.$set || {}) };
    delete set.updatedAt;
    return { set: mask(set) };
  } catch (e) {
    return { error: e.message };
  }
}
const mine = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { error: e.message };
  }
};

let bad = 0;
const seen = new Set();
for (const [schema, Model, name] of [
  [PRODUCT, productModel, "product"],
  [CATEGORY, shopCategoryModel, "category"],
  [SETTINGS, shopSettingsModel, "settings"],
]) {
  let diffs = 0;
  for (let i = 0; i < N; i++) {
    const raw = genFor(schema, name !== "settings");
    const raw2 = JSON.parse(JSON.stringify(raw, (k, v) => (v === undefined ? null : v)));
    // createProduct rejects non-object variants before Mongoose sees them.
    const createReachable = name !== "product" || raw2.variants === undefined || (Array.isArray(raw2.variants) && raw2.variants.every((v) => v && typeof v === "object"));
    if (name !== "settings" && createReachable) {
      const o = await oracleCreate(Model, JSON.parse(JSON.stringify(raw2)));
      const m = mine(() => {
        const d = buildDocument(schema, JSON.parse(JSON.stringify(raw2)));
        return { doc: mask(d) };
      });
      if (canon(o) !== canon(m)) {
        diffs++;
        const key = `create|${(o.error || "").replace(/".*?"/g, "X").slice(0, 60)}|${(m.error || "").replace(/".*?"/g, "X").slice(0, 60)}`;
        if (!seen.has(key)) {
          seen.add(key);
          console.log(`[${name}] CREATE ${JSON.stringify(raw2)}\n   oracle ${JSON.stringify(o)}\n   mine   ${JSON.stringify(m)}`);
        }
      }
    }
    const o = oracleUpdate(Model, JSON.parse(JSON.stringify(raw2)));
    const m = mine(() => ({ set: mask(castUpdate(schema, JSON.parse(JSON.stringify(raw2)))) }));
    if (canon(o) !== canon(m)) {
      diffs++;
      const key = `update|${(o.error || "").replace(/".*?"/g, "X").slice(0, 60)}|${(m.error || "").replace(/".*?"/g, "X").slice(0, 60)}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`[${name}] UPDATE ${JSON.stringify(raw2)}\n   oracle ${JSON.stringify(o)}\n   mine   ${JSON.stringify(m)}`);
      }
    }
  }
  console.log(`${name}: ${diffs} differing cases of ${N * (name === "settings" ? 1 : 2)}`);
  bad += diffs;
}
process.exit(bad ? 1 : 0);
