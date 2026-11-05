// Import bhajan taxonomy rows (composers, categories, moods, festivals).
//
//   node scripts/import-bhajan-taxonomy.js <taxonomy.final.json> [--dry-run]
//
// File: [{ type, slug, name:{en,te,hi}, description:{en,te,hi}, image, songCount, order }]
// Idempotent: upserts by (type, slug), never deletes. songCount is ignored
// (counts are computed live). --dry-run validates only and never connects to
// the database. MONGO_URI comes from the server .env and is never printed.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!file) {
  console.error("Usage: node scripts/import-bhajan-taxonomy.js <taxonomy.final.json> [--dry-run]");
  process.exit(1);
}

const TYPES = ["author", "category", "mood", "festival"];
const LANGS = ["en", "te", "hi"];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isUrl = (s) => typeof s === "string" && /^https?:\/\/\S+$/i.test(s);

function validateLang(obj, label, errs) {
  if (obj === undefined) return;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return errs.push(`${label} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!LANGS.includes(k)) errs.push(`${label} has unknown language "${k}"`);
    else if (typeof obj[k] !== "string") errs.push(`${label}.${k} must be a string`);
  }
}

function validate(d) {
  const errs = [];
  if (!d || typeof d !== "object") return ["not an object"];
  if (!TYPES.includes(d.type)) errs.push(`type must be one of ${TYPES.join("|")}`);
  if (typeof d.slug !== "string" || !SLUG_RE.test(d.slug)) errs.push("slug missing or not lowercase-hyphen");
  validateLang(d.name, "name", errs);
  validateLang(d.description, "description", errs);
  if (!d.name || !(d.name.en || "").trim()) errs.push("name.en missing");
  if (d.image && !isUrl(d.image)) errs.push("image must be '' or an http(s) URL");
  if (d.order !== undefined && !Number.isFinite(Number(d.order))) errs.push("order must be a number");
  return errs;
}

const lang = (o) => ({ en: (o && o.en) || "", te: (o && o.te) || "", hi: (o && o.hi) || "" });

(async () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (e) {
    console.error(`Cannot read/parse ${file}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error("Input must be a JSON array.");
    process.exit(1);
  }
  const seen = new Set();
  const docs = [];
  let invalid = 0;
  let dupes = 0;
  raw.forEach((d, i) => {
    const errs = validate(d);
    if (errs.length) {
      invalid++;
      console.error(`INVALID #${i} (${d && d.type}/${d && d.slug}): ${errs.join("; ")}`);
      return;
    }
    const key = `${d.type}/${d.slug}`;
    if (seen.has(key)) {
      dupes++;
      console.error(`DUPLICATE ${key} (skipped)`);
      return;
    }
    seen.add(key);
    docs.push(d);
  });
  const per = TYPES.map((t) => `${t}=${docs.filter((d) => d.type === t).length}`).join(" ");
  const noTe = docs.filter((d) => !(d.name.te || "").trim()).length;
  console.log(
    `${dryRun ? "[dry-run] " : ""}Read ${raw.length} entries, ${docs.length} valid (${per}), ${invalid} invalid, ` +
      `${dupes} duplicates. Without Telugu name: ${noTe}, with image: ${docs.filter((d) => d.image).length}.`
  );
  if (dryRun) {
    console.log("[dry-run] No database connection was made.");
    process.exit(invalid ? 2 : 0);
  }
  if (invalid) {
    console.error("Refusing to import while entries are invalid.");
    process.exit(2);
  }

  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in the server .env");
    process.exit(1);
  }
  const mongoose = require("mongoose");
  const { bhajanTaxonModel } = require("../src/models/bhajanTaxon.model");
  await mongoose.connect(process.env.MONGO_URI);
  let inserted = 0, updated = 0, failed = 0;
  try {
    for (const d of docs) {
      try {
        const set = { name: lang(d.name), description: lang(d.description), image: d.image || "" };
        if (d.order !== undefined) set.order = Number(d.order);
        const res = await bhajanTaxonModel.updateOne(
          { type: d.type, slug: d.slug },
          { $set: set, $setOnInsert: { type: d.type, slug: d.slug, isPublished: true } },
          { upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );
        if (res.upsertedCount) inserted++;
        else updated++;
      } catch (e) {
        failed++;
        console.error(`FAILED ${d.type}/${d.slug}: ${e.message}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
  console.log(`Done. inserted=${inserted} updated=${updated} failed=${failed}`);
  process.exit(failed ? 3 : 0);
})();
