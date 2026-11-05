// Import bhajans from a JSON file (array of documents shaped like the bhajans
// spec, with final R2 URLs) into the `bhajans` collection.
//
//   node scripts/import-bhajans.js <path-to-bhajans.final.json> [--dry-run] [--only=slug1,slug2]
//
// Idempotent: upserts by slug, never deletes, keeps an existing playCount.
// --dry-run validates the file and prints a summary WITHOUT connecting to the
// database. Connection string comes from MONGO_URI in the server .env (never printed).

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg
  ? new Set(onlyArg.slice(7).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
  : null;

if (!file) {
  console.error("Usage: node scripts/import-bhajans.js <bhajans.final.json> [--dry-run] [--only=slug1,slug2]");
  process.exit(1);
}

const LANGS = ["en", "te", "hi"];
const isUrl = (s) => typeof s === "string" && /^https?:\/\/\S+$/i.test(s);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validate(doc, i) {
  const errs = [];
  const warns = [];
  if (!doc || typeof doc !== "object") return { errs: [`#${i}: not an object`], warns };
  if (typeof doc.slug !== "string" || !SLUG_RE.test(doc.slug)) errs.push("slug missing or not lowercase-hyphen");
  if (typeof doc.title !== "string" || !doc.title.trim()) errs.push("title missing");
  for (const k of ["categories", "moods", "festivals", "languages", "tracks", "verses"]) {
    if (doc[k] !== undefined && !Array.isArray(doc[k])) errs.push(`${k} must be an array`);
  }
  for (const l of doc.languages || []) if (!LANGS.includes(l)) errs.push(`unknown language "${l}"`);
  if (doc.coverImage && !isUrl(doc.coverImage)) errs.push("coverImage must be '' or an http(s) URL");
  (Array.isArray(doc.tracks) ? doc.tracks : []).forEach((t, j) => {
    if (!t || !isUrl(t.url)) errs.push(`tracks[${j}].url must be an http(s) URL`);
    if (t && t.verseTimes !== undefined) {
      const vt = t.verseTimes;
      if (!Array.isArray(vt) || vt.length > 500) errs.push(`tracks[${j}].verseTimes must be an array of at most 500 numbers`);
      else if (!vt.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) errs.push(`tracks[${j}].verseTimes must be finite numbers >= 0`);
      else if (vt.some((x, k) => k > 0 && x < vt[k - 1])) errs.push(`tracks[${j}].verseTimes must be non-decreasing`);
    }
    if (t && t.duration !== undefined && !(Number(t.duration) >= 0)) errs.push(`tracks[${j}].duration invalid`);
  });
  (Array.isArray(doc.verses) ? doc.verses : []).forEach((v, j) => {
    if (!v || typeof v !== "object") return errs.push(`verses[${j}] not an object`);
    if (v.text) for (const l of Object.keys(v.text)) {
      if (!LANGS.includes(l)) errs.push(`verses[${j}].text has unknown key "${l}"`);
      else if (!Array.isArray(v.text[l])) errs.push(`verses[${j}].text.${l} must be an array of lines`);
    }
  });
  if (doc.source && doc.source.url && !isUrl(doc.source.url)) errs.push("source.url must be an http(s) URL");
  if (!Array.isArray(doc.verses) || !doc.verses.length) warns.push("no verses");
  return { errs, warns: warns };
}

// Fields written on every run. playCount is never written (preserved / default 0 on insert).
const FIELDS = [
  "title", "artist", "authorSlug", "subtitle", "categories", "moods", "festivals",
  "languages", "coverImage", "isFeatured", "isPublished", "sortOrder", "tracks",
  "verses", "lyricsText", "source",
];

(async () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (e) {
    console.error(`Cannot read/parse ${file}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error("Input must be a JSON array of bhajan documents.");
    process.exit(1);
  }

  const seen = new Set();
  const docs = [];
  let invalid = 0;
  let dupes = 0;
  let noVerses = 0;
  raw.forEach((d, i) => {
    if (only && !only.has(String(d && d.slug).toLowerCase())) return;
    const { errs, warns } = validate(d, i);
    if (errs.length) {
      invalid++;
      console.error(`INVALID #${i} (${d && d.slug}): ${errs.join("; ")}`);
      return;
    }
    if (seen.has(d.slug)) {
      dupes++;
      console.error(`DUPLICATE slug in file: ${d.slug} (skipped)`);
      return;
    }
    seen.add(d.slug);
    if (warns.includes("no verses")) noVerses++;
    docs.push(d);
  });

  const withAudio = docs.filter((d) => (d.tracks || []).length).length;
  const withCover = docs.filter((d) => d.coverImage).length;
  const tracks = docs.reduce((n, d) => n + (d.tracks || []).length, 0);
  console.log(
    `${dryRun ? "[dry-run] " : ""}Read ${raw.length} entries, ${docs.length} valid` +
      (only ? ` (filtered by --only)` : "") +
      `, ${invalid} invalid, ${dupes} duplicate slugs. ` +
      `With audio: ${withAudio} (${tracks} tracks), with cover: ${withCover}, without verses: ${noVerses}.`
  );

  if (dryRun) {
    console.log("[dry-run] No database connection was made.");
    process.exit(invalid ? 2 : 0);
  }
  if (invalid) {
    console.error("Refusing to import while entries are invalid. Fix them or use --only.");
    process.exit(2);
  }

  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in the server .env");
    process.exit(1);
  }
  const mongoose = require("mongoose");
  const { bhajanModel } = require("../src/models/bhajan.model");
  await mongoose.connect(process.env.MONGO_URI);

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  try {
    for (const d of docs) {
      try {
        const set = {};
        for (const f of FIELDS) if (d[f] !== undefined) set[f] = d[f];
        if (set.isPublished === undefined) set.isPublished = true;
        const res = await bhajanModel.updateOne(
          { slug: d.slug },
          { $set: set, $setOnInsert: { slug: d.slug, playCount: 0 } },
          { upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );
        if (res.upsertedCount) inserted++;
        else updated++;
      } catch (e) {
        failed++;
        console.error(`FAILED ${d.slug}: ${e.message}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
  console.log(`Done. inserted=${inserted} updated=${updated} failed=${failed}`);
  process.exit(failed ? 3 : 0);
})();
