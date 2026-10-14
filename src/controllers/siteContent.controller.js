import { siteContent } from "../db/tables.js";
import { query } from "../db/pg.js";
import { DEFAULT_CONSTRUCTION_VIDEO_ID, siteContentDefaults } from "../domain/siteContent.js";
import { toBool } from "../domain/validate.js";

const MAX_CONSTRUCTION_PHOTOS = 24;

// Accepts shorts, watch, youtu.be, embed, live and v/ links, or a bare 11-char id.
const parseYouTubeId = (raw) => {
  const input = String(raw || "").trim();
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  const patterns = [
    /youtube(?:-nocookie)?\.com\/shorts\/([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    /youtube(?:-nocookie)?\.com\/watch\?[^]*?\bv=([A-Za-z0-9_-]{11})/i,
    /youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/i,
    /youtube(?:-nocookie)?\.com\/live\/([A-Za-z0-9_-]{11})/i,
    /youtube(?:-nocookie)?\.com\/v\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m) return m[1];
  }
  return null;
};

// Whole sections are replaced on update, keeping only the keys the schema knows.
const str = (v) => (v === undefined || v === null ? undefined : String(v));
const strings = (obj, keys) => {
  const out = {};
  for (const k of keys) {
    const v = str(obj?.[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
};
const SECTION_PICKERS = {
  hero: (v) => strings(v, ["title", "subtitle", "tagline"]),
  about: (v) => strings(v, ["heading", "body"]),
  contact: (v) => strings(v, ["phone", "email", "address", "morningHours", "eveningHours"]),
  navbar: (v) => {
    const out = strings(v, ["majorFestival"]);
    if (v?.customLink && typeof v.customLink === "object") {
      const cl = strings(v.customLink, ["label", "href"]);
      if (v.customLink.enabled !== undefined) cl.enabled = toBool(v.customLink.enabled);
      out.customLink = cl;
    }
    return out;
  },
  festival: (v) => strings(v, ["bannerDesktop", "bannerMobile"]),
};

// Mongoose filled missing sub-fields with schema defaults whenever a document was read.
const withDefaults = (doc) => {
  const defaults = siteContentDefaults();
  const out = { ...doc };
  for (const [section, def] of Object.entries(defaults)) out[section] = { ...def, ...(doc[section] || {}) };
  out.navbar.customLink = { ...defaults.navbar.customLink, ...(doc.navbar?.customLink || {}) };
  return out;
};

const getOrCreate = async () => {
  const existing = await siteContent.findOne({ key: "main" });
  if (existing) return withDefaults(existing);
  await siteContent.insert({ key: "main", ...siteContentDefaults() }, { onConflictDoNothing: true });
  return withDefaults(await siteContent.findOne({ key: "main" }));
};

const siteContentController = {
  get: async (req, res) => {
    try {
      res.status(200).json({ content: await getOrCreate() });
    } catch (err) {
      console.error("Site content get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const { construction } = req.body;
      const sections = {};
      for (const name of Object.keys(SECTION_PICKERS)) {
        if (req.body[name]) sections[name] = SECTION_PICKERS[name](req.body[name]);
      }

      let constructionPatch;
      if (construction) {
        const url = String(construction.videoUrl || "").trim();
        const videoId = parseYouTubeId(url);
        if (url && !videoId) {
          return res.status(400).json({
            message:
              "That doesn't look like a YouTube link. Paste the Share link from the video — e.g. https://youtube.com/shorts/XXXXXXXXXXX",
          });
        }
        // Merged key by key so saving the video never wipes the photo gallery.
        constructionPatch = { videoUrl: url, videoId: videoId || DEFAULT_CONSTRUCTION_VIDEO_ID, updatedAt: new Date() };
        if (Array.isArray(construction.photos)) {
          constructionPatch.photos = construction.photos
            .map((p) => ({
              url: String(p?.url || "").trim(),
              caption: String(p?.caption || "")
                .trim()
                .slice(0, 80),
            }))
            .filter((p) => p.url)
            .slice(0, MAX_CONSTRUCTION_PHOTOS);
        }
      }

      await getOrCreate();
      const params = [];
      const sets = [];
      const bind = (v) => {
        params.push(v);
        return `$${params.length}`;
      };
      for (const [name, value] of Object.entries(sections))
        sets.push(`"${name}" = ${bind(JSON.stringify(value))}::jsonb`);
      if (constructionPatch)
        sets.push(
          `construction = COALESCE(construction, '{}'::jsonb) || ${bind(JSON.stringify(constructionPatch))}::jsonb`
        );
      if (req.user?.userId) sets.push(`updated_by = ${bind(req.user.userId)}`);
      sets.push("updated_at = now()");

      const { rows } = await query(`UPDATE site_content SET ${sets.join(", ")} WHERE key = 'main' RETURNING *`, params);
      res.status(200).json({ message: "Content updated", content: withDefaults(siteContent.fromRow(rows[0])) });
    } catch (err) {
      console.error("Site content update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

export { siteContentController };
