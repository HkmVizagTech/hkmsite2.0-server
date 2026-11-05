const fs = require("fs");
const mongoose = require("mongoose");
const { bhajanModel, BHAJAN_LANGS } = require("../models/bhajan.model");
const { bhajanTaxonomy } = require("../constants/bhajanTaxonomy");
const { bhajanTaxonModel, TAXON_TYPES, TAXON_LANGS } = require("../models/bhajanTaxon.model");
const { slugify } = require("../utils/slug");
const { uploadToR2, deleteFromR2 } = require("../utils/r2");
const { uploadAudioToR2 } = require("../utils/r2Audio");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const str = (v) => (typeof v === "string" ? v : "");
const slugParam = (v) => str(v).trim().toLowerCase().slice(0, 120);

// Summary fields only; never verses or lyrics in a list.
const SUMMARY_PROJECTION = {
  slug: 1, title: 1, artist: 1, authorSlug: 1, categories: 1, moods: 1,
  festivals: 1, languages: 1, coverImage: 1, isFeatured: 1, playCount: 1,
  "tracks.duration": 1, "tracks.order": 1, updatedAt: 1,
};

const toSummary = (d, { admin = false } = {}) => {
  const tracks = Array.isArray(d.tracks) ? d.tracks : [];
  const first = tracks.length
    ? tracks.reduce((a, b) => ((b.order || 0) < (a.order || 0) ? b : a))
    : null;
  const out = {
    _id: d._id,
    slug: d.slug,
    title: d.title,
    artist: d.artist || "",
    authorSlug: d.authorSlug || "",
    categories: d.categories || [],
    moods: d.moods || [],
    festivals: d.festivals || [],
    languages: d.languages || [],
    coverImage: d.coverImage || "",
    isFeatured: !!d.isFeatured,
    hasAudio: tracks.length > 0,
    trackCount: tracks.length,
    duration: first ? first.duration || 0 : 0,
    playCount: d.playCount || 0,
    updatedAt: d.updatedAt,
  };
  if (admin) {
    out.isPublished = d.isPublished !== false;
    out.sortOrder = d.sortOrder || 0;
  }
  return out;
};

const SORTS = {
  featured: { isFeatured: -1, sortOrder: -1, playCount: -1, title: 1 },
  new: { createdAt: -1 },
  title: { title: 1 },
  plays: { playCount: -1, title: 1 },
};

const searchClause = (q) => {
  const rx = new RegExp(escapeRegex(q.slice(0, 100)), "i");
  return { $or: [{ title: rx }, { artist: rx }, { lyricsText: rx }] };
};

const listHandler = (admin) => async (req, res) => {
  try {
    const q = str(req.query.q).trim();
    const page = clampInt(req.query.page, 1, 1, 100000);
    const limit = clampInt(req.query.limit, 24, 1, 60);
    const filter = {};
    if (admin) {
      const p = str(req.query.published);
      if (p === "true") filter.isPublished = true;
      else if (p === "false") filter.isPublished = false;
    } else {
      filter.isPublished = true;
    }
    if (q) Object.assign(filter, searchClause(q));
    if (!admin) {
      const category = slugParam(req.query.category);
      const mood = slugParam(req.query.mood);
      const festival = slugParam(req.query.festival);
      const artist = slugParam(req.query.artist);
      if (category) filter.categories = category;
      if (mood) filter.moods = mood;
      if (festival) filter.festivals = festival;
      if (artist) filter.authorSlug = artist;
    }
    const featured = str(req.query.featured);
    if (featured === "true") filter.isFeatured = true;
    else if (featured === "false") filter.isFeatured = { $ne: true };
    const hasAudio = str(req.query.hasAudio);
    if (hasAudio === "true") filter["tracks.0"] = { $exists: true };
    else if (hasAudio === "false") filter["tracks.0"] = { $exists: false };
    const sort = SORTS[str(req.query.sort)] || (admin ? SORTS.new : SORTS.featured);
    const projection = admin
      ? { ...SUMMARY_PROJECTION, isPublished: 1, sortOrder: 1 }
      : SUMMARY_PROJECTION;

    const [docs, total] = await Promise.all([
      bhajanModel
        .find(filter, projection)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      bhajanModel.countDocuments(filter),
    ]);
    res.status(200).json({
      items: docs.map((d) => toSummary(d, { admin })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("bhajan.list error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Unique slug: base, base-2, base-3 ... (ignoring the doc being edited).
const uniqueSlug = async (base, excludeId) => {
  const root = slugify(base) || "bhajan";
  let candidate = root;
  for (let i = 2; i < 1000; i++) {
    const clash = await bhajanModel.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!clash) return candidate;
    candidate = `${root}-${i}`;
  }
  return `${root}-${Date.now()}`;
};

const strArr = (v) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))]
    : [];

const lineArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);

const cleanVerses = (verses) =>
  (Array.isArray(verses) ? verses : []).map((v, i) => {
    const out = { number: Number.isFinite(Number(v && v.number)) ? Number(v.number) : i + 1, text: {}, translation: {} };
    for (const l of BHAJAN_LANGS) {
      const lines = lineArr(v && v.text && v.text[l]);
      if (lines && lines.length) out.text[l] = lines;
      const tr = v && v.translation && v.translation[l];
      if (typeof tr === "string" && tr.trim()) out.translation[l] = tr;
    }
    const wbw = v && v.wordByWord && v.wordByWord.en;
    if (Array.isArray(wbw)) {
      out.wordByWord = {
        en: wbw
          .filter((w) => w && typeof w.word === "string")
          .map((w) => ({ word: w.word, meaning: str(w.meaning) })),
      };
    }
    return out;
  });

const MAX_VERSE_TIMES = 500;
const badRequest = (message) => Object.assign(new Error(message), { badRequest: true });

// Verse start times (seconds): drop non-finite, clamp length, round to 2 dp,
// reject negatives and decreasing sequences with a clear message.
const cleanVerseTimes = (v) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest("verseTimes must be an array of numbers");
  const nums = v
    .filter((x) => (typeof x === "number" || (typeof x === "string" && x.trim() !== "")) && Number.isFinite(Number(x)))
    .slice(0, MAX_VERSE_TIMES)
    .map((x) => Math.round(Number(x) * 100) / 100);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] < 0) throw badRequest(`verseTimes[${i}] must be >= 0`);
    if (i > 0 && nums[i] < nums[i - 1]) {
      throw badRequest(`verseTimes must be non-decreasing (entry ${i} is earlier than entry ${i - 1})`);
    }
  }
  return nums;
};

const cleanTracks = (tracks) =>
  (Array.isArray(tracks) ? tracks : [])
    .filter((t) => t && typeof t.url === "string" && t.url.trim())
    .map((t, i) => {
      const out = {
        singer: str(t.singer).trim(),
        url: t.url.trim(),
        duration: Math.max(0, Number(t.duration) || 0),
        order: Number.isFinite(Number(t.order)) ? Number(t.order) : i,
        bytes: Math.max(0, Number(t.bytes) || 0),
        verseTimes: cleanVerseTimes(t.verseTimes),
      };
      if (t._id && mongoose.isValidObjectId(t._id)) out._id = t._id;
      return out;
    });

// Whitelist + normalise a request body into a document patch.
const buildPatch = (body) => {
  const b = body || {};
  const p = {};
  for (const k of ["title", "artist", "subtitle", "lyricsText", "coverImage"]) {
    if (typeof b[k] === "string") p[k] = k === "lyricsText" || k === "coverImage" ? b[k] : b[k].trim();
  }
  if (typeof b.authorSlug === "string") p.authorSlug = slugify(b.authorSlug);
  for (const k of ["categories", "moods", "festivals"]) if (k in b) p[k] = strArr(b[k]);
  if ("languages" in b) p.languages = strArr(b.languages).filter((l) => BHAJAN_LANGS.includes(l));
  if ("isFeatured" in b) p.isFeatured = !!b.isFeatured;
  if ("isPublished" in b) p.isPublished = !!b.isPublished;
  if ("sortOrder" in b) p.sortOrder = Number(b.sortOrder) || 0;
  if ("tracks" in b) p.tracks = cleanTracks(b.tracks);
  if ("verses" in b) p.verses = cleanVerses(b.verses);
  if (b.source && typeof b.source === "object") {
    p.source = { name: str(b.source.name), url: str(b.source.url) };
  }
  if (typeof b.slug === "string" && b.slug.trim()) p.slug = slugify(b.slug);
  return p;
};

// R2 object key from a public URL, only for our own bhajans/ folder.
const bhajanKeyFromUrl = (url) => {
  if (typeof url !== "string") return null;
  const base = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base || !url.startsWith(base + "/")) return null;
  const key = decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0]);
  return key.startsWith("bhajans/") && !key.includes("..") ? key : null;
};

const dupKeyError = (err) => err && (err.code === 11000 || err.code === 11001);

const sendUpload = (kind, uploader, folder) => async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: "No file uploaded" });
  try {
    const up = await uploader(file.path, folder);
    res.status(200).json({ url: up.secure_url, bytes: up.bytes });
  } catch (err) {
    console.error(`bhajan.upload ${kind} error:`, err);
    res.status(500).json({ message: "Upload failed" });
  } finally {
    try { fs.unlinkSync(file.path); } catch {}
  }
};

// Light per-IP+slug play rate limit (30 min); in-memory, best effort.
const PLAY_WINDOW_MS = 30 * 60 * 1000;
const recentPlays = new Map();
const playAllowed = (key) => {
  const now = Date.now();
  if (recentPlays.size > 5000) {
    for (const [k, t] of recentPlays) if (now - t > PLAY_WINDOW_MS) recentPlays.delete(k);
    if (recentPlays.size > 5000) recentPlays.clear();
  }
  const last = recentPlays.get(key);
  if (last && now - last < PLAY_WINDOW_MS) return false;
  recentPlays.set(key, now);
  return true;
};

// ---------- Taxonomy pages (composers, categories, moods, festivals) ----------
const TAXON_FIELD = { author: "authorSlug", category: "categories", mood: "moods", festival: "festivals" };
const TAXON_CONST = { category: "categories", mood: "moods", festival: "festivals" };

const emptyLang = () => ({ en: "", te: "", hi: "" });
const cleanLang = (v) => {
  const out = emptyLang();
  if (v && typeof v === "object") for (const l of TAXON_LANGS) out[l] = str(v[l]).trim();
  return out;
};
const titleCase = (slug) =>
  String(slug).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// Live counts per slug for one taxonomy type, from ONE aggregation.
const taxonCounts = async (type) => {
  const field = TAXON_FIELD[type];
  const pipeline = [{ $match: { isPublished: true } }];
  if (type !== "author") pipeline.push({ $unwind: `$${field}` });
  else pipeline.push({ $match: { authorSlug: { $ne: "" } } });
  pipeline.push({
    $group: {
      _id: `$${field}`,
      artist: { $first: "$artist" },
      songCount: { $sum: 1 },
      audioCount: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$tracks", []] } }, 0] }, 1, 0] } },
    },
  });
  const rows = await bhajanModel.aggregate(pipeline);
  return new Map(rows.map((r) => [r._id, r]));
};

const buildTaxonItems = async (type, { admin = false } = {}) => {
  const [counts, rows] = await Promise.all([
    taxonCounts(type),
    bhajanTaxonModel.find({ type }).lean(),
  ]);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const slugs = new Set([...counts.keys(), ...rows.map((r) => r.slug)]);
  if (TAXON_CONST[type]) for (const s of Object.keys(bhajanTaxonomy[TAXON_CONST[type]])) slugs.add(s);

  const items = [];
  for (const slug of slugs) {
    if (!slug) continue;
    const row = bySlug.get(slug);
    if (row && row.isPublished === false && !admin) continue;
    const c = counts.get(slug);
    const fallbackName =
      type === "author" ? (c && c.artist) || titleCase(slug) : bhajanTaxonomy[TAXON_CONST[type]][slug] || titleCase(slug);
    const name = { ...emptyLang(), ...(row && row.name ? row.name : {}) };
    if (!name.en) name.en = fallbackName;
    const item = {
      type,
      slug,
      name: { en: name.en, te: name.te || "", hi: name.hi || "" },
      description: { ...emptyLang(), ...(row && row.description ? row.description : {}) },
      image: (row && row.image) || "",
      order: row && Number.isFinite(row.order) ? row.order : 0,
      songCount: c ? c.songCount : 0,
      audioCount: c ? c.audioCount : 0,
    };
    delete item.description._id;
    if (admin) item.isPublished = row ? row.isPublished !== false : true;
    items.push(item);
  }
  return items;
};

const sortTaxonItems = (items) =>
  items.sort((a, b) => a.order - b.order || b.songCount - a.songCount || a.name.en.localeCompare(b.name.en));

const taxonType = (req, res) => {
  const type = str(req.params.type).toLowerCase();
  if (!TAXON_TYPES.includes(type)) {
    res.status(404).json({ message: "Unknown taxonomy type" });
    return null;
  }
  return type;
};

const bhajanController = {
  list: listHandler(false),
  adminList: listHandler(true),

  meta: async (req, res) => {
    try {
      const counted = async (field) => {
        const rows = await bhajanModel.aggregate([
          { $match: { isPublished: true } },
          { $unwind: `$${field}` },
          { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        ]);
        return new Map(rows.map((r) => [r._id, r.count]));
      };
      const taxRows = await bhajanTaxonModel
        .find({ type: { $in: ["category", "mood", "festival"] }, isPublished: true }, { type: 1, slug: 1, "name.en": 1 })
        .lean();
      const taxName = (type, slug) => {
        const row = taxRows.find((r) => r.type === type && r.slug === slug);
        return row && row.name && row.name.en ? row.name.en : null;
      };
      const toList = (group, counts, type) =>
        Object.entries(group)
          .map(([slug, label]) => ({ slug, label: taxName(type, slug) || label, count: counts.get(slug) || 0 }))
          .filter((x) => x.count > 0)
          .sort((a, b) => b.count - a.count);

      const [cats, moods, fests, artistRows, totalsRows] = await Promise.all([
        counted("categories"),
        counted("moods"),
        counted("festivals"),
        bhajanModel.aggregate([
          { $match: { isPublished: true, authorSlug: { $ne: "" } } },
          { $group: { _id: "$authorSlug", name: { $first: "$artist" }, count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 60 },
        ]),
        bhajanModel.aggregate([
          { $match: { isPublished: true } },
          {
            $group: {
              _id: null,
              bhajans: { $sum: 1 },
              withAudio: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$tracks", []] } }, 0] }, 1, 0] } },
            },
          },
        ]),
      ]);
      const totals = totalsRows[0] || { bhajans: 0, withAudio: 0 };
      res.status(200).json({
        categories: toList(bhajanTaxonomy.categories, cats, "category"),
        moods: toList(bhajanTaxonomy.moods, moods, "mood"),
        festivals: toList(bhajanTaxonomy.festivals, fests, "festival"),
        artists: artistRows.map((a) => ({ slug: a._id, name: a.name || a._id, count: a.count })),
        totals: { bhajans: totals.bhajans, withAudio: totals.withAudio },
      });
    } catch (err) {
      console.error("bhajan.meta error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  getBySlug: async (req, res) => {
    try {
      const doc = await bhajanModel.findOne({ slug: slugParam(req.params.slug), isPublished: true }).lean();
      if (!doc) return res.status(404).json({ message: "Bhajan not found" });
      res.status(200).json(doc);
    } catch (err) {
      console.error("bhajan.getBySlug error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  play: async (req, res) => {
    try {
      const slug = slugParam(req.params.slug);
      if (playAllowed(`${req.ip}|${slug}`)) {
        await bhajanModel.updateOne({ slug, isPublished: true }, { $inc: { playCount: 1 } });
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("bhajan.play error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  adminGet: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Bhajan not found" });
      const doc = await bhajanModel.findById(req.params.id).lean();
      if (!doc) return res.status(404).json({ message: "Bhajan not found" });
      res.status(200).json(doc);
    } catch (err) {
      console.error("bhajan.adminGet error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      const patch = buildPatch(req.body);
      if (!patch.title) return res.status(400).json({ message: "Title is required" });
      patch.slug = await uniqueSlug(patch.slug || patch.title);
      const doc = await bhajanModel.create(patch);
      res.status(201).json(doc.toObject());
    } catch (err) {
      if (err && err.badRequest) return res.status(400).json({ message: err.message });
      if (dupKeyError(err)) return res.status(409).json({ message: "A bhajan with this slug already exists" });
      if (err && err.name === "ValidationError") return res.status(400).json({ message: err.message });
      console.error("bhajan.create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Bhajan not found" });
      const patch = buildPatch(req.body);
      if ("title" in patch && !patch.title) return res.status(400).json({ message: "Title cannot be empty" });
      if ("slug" in patch) {
        if (!patch.slug) delete patch.slug;
        else patch.slug = await uniqueSlug(patch.slug, req.params.id);
      }
      const doc = await bhajanModel.findByIdAndUpdate(req.params.id, { $set: patch }, {
        new: true,
        runValidators: true,
      }).lean();
      if (!doc) return res.status(404).json({ message: "Bhajan not found" });
      res.status(200).json(doc);
    } catch (err) {
      if (err && err.badRequest) return res.status(400).json({ message: err.message });
      if (dupKeyError(err)) return res.status(409).json({ message: "A bhajan with this slug already exists" });
      if (err && err.name === "ValidationError") return res.status(400).json({ message: err.message });
      console.error("bhajan.update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Bhajan not found" });
      const doc = await bhajanModel.findById(req.params.id);
      if (!doc) return res.status(404).json({ message: "Bhajan not found" });
      const keys = [doc.coverImage, ...(doc.tracks || []).map((t) => t.url)]
        .map(bhajanKeyFromUrl)
        .filter(Boolean);
      await doc.deleteOne();
      for (const key of keys) {
        try {
          await deleteFromR2(key);
        } catch (e) {
          console.warn("bhajan.delete R2 destroy failed:", key, e && e.message);
        }
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("bhajan.delete error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  taxonomyList: async (req, res) => {
    try {
      const type = taxonType(req, res);
      if (!type) return;
      let items = await buildTaxonItems(type);
      if (type === "author") items = items.filter((i) => i.songCount > 0);
      const q = str(req.query.q).trim().toLowerCase();
      if (q) {
        items = items.filter(
          (i) => i.slug.includes(q) || [i.name.en, i.name.te, i.name.hi].some((n) => n.toLowerCase().includes(q))
        );
      }
      sortTaxonItems(items);
      const limit = parseInt(req.query.limit, 10);
      if (Number.isFinite(limit) && limit > 0) items = items.slice(0, Math.min(limit, 500));
      res.status(200).json({ items });
    } catch (err) {
      console.error("bhajan.taxonomyList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  taxonomyGet: async (req, res) => {
    try {
      const type = taxonType(req, res);
      if (!type) return;
      const slug = slugParam(req.params.slug);
      const items = await buildTaxonItems(type);
      const item = items.find((i) => i.slug === slug);
      const known = item && (item.songCount > 0 || type !== "author");
      if (!known) return res.status(404).json({ message: "Not found" });

      const field = TAXON_FIELD[type];
      const base = { isPublished: true, [field]: slug };
      const withAudio = await bhajanModel
        .find({ ...base, "tracks.0": { $exists: true } }, SUMMARY_PROJECTION)
        .sort({ playCount: -1, title: 1 })
        .limit(12)
        .lean();
      let docs = withAudio;
      if (docs.length < 12) {
        const rest = await bhajanModel
          .find({ ...base, "tracks.0": { $exists: false } }, SUMMARY_PROJECTION)
          .sort({ isFeatured: -1, playCount: -1, title: 1 })
          .limit(12 - docs.length)
          .lean();
        docs = docs.concat(rest);
      }
      res.status(200).json({ ...item, topSongs: docs.map((d) => toSummary(d)) });
    } catch (err) {
      console.error("bhajan.taxonomyGet error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  adminTaxonomyList: async (req, res) => {
    try {
      const type = taxonType(req, res);
      if (!type) return;
      const items = sortTaxonItems(await buildTaxonItems(type, { admin: true }));
      res.status(200).json({ items });
    } catch (err) {
      console.error("bhajan.adminTaxonomyList error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  adminTaxonomyUpsert: async (req, res) => {
    try {
      const type = taxonType(req, res);
      if (!type) return;
      const slug = slugParam(req.params.slug);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return res.status(400).json({ message: "Invalid slug" });
      const b = req.body || {};
      const set = {};
      if ("name" in b) set.name = cleanLang(b.name);
      if ("description" in b) set.description = cleanLang(b.description);
      if (typeof b.image === "string") set.image = b.image.trim();
      if ("order" in b) set.order = Number(b.order) || 0;
      if ("isPublished" in b) set.isPublished = !!b.isPublished;
      await bhajanTaxonModel.updateOne(
        { type, slug },
        { $set: set, $setOnInsert: { type, slug } },
        { upsert: true, runValidators: true, setDefaultsOnInsert: true }
      );
      const item = (await buildTaxonItems(type, { admin: true })).find((i) => i.slug === slug);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === "ValidationError") return res.status(400).json({ message: err.message });
      console.error("bhajan.adminTaxonomyUpsert error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  updateVerseTimes: async (req, res) => {
    try {
      const { id, trackId } = req.params;
      if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(trackId)) {
        return res.status(404).json({ message: "Track not found" });
      }
      const verseTimes = cleanVerseTimes((req.body || {}).verseTimes);
      const doc = await bhajanModel.findOneAndUpdate(
        { _id: id, "tracks._id": trackId },
        { $set: { "tracks.$.verseTimes": verseTimes } },
        { new: true }
      ).lean();
      if (!doc) return res.status(404).json({ message: "Track not found" });
      const track = doc.tracks.find((t) => String(t._id) === trackId);
      res.status(200).json(track);
    } catch (err) {
      if (err && err.badRequest) return res.status(400).json({ message: err.message });
      console.error("bhajan.updateVerseTimes error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  uploadTaxonomyImage: sendUpload("taxonomy", uploadToR2, "bhajans/taxonomy"),

  uploadCover: sendUpload("cover", uploadToR2, "bhajans/covers"),
  uploadAudio: sendUpload("audio", uploadAudioToR2, "bhajans/audio"),
};

module.exports = { bhajanController, escapeRegex, buildPatch, bhajanKeyFromUrl };
