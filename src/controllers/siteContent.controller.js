import { siteContent } from "../db/tables.js";
import { query } from "../db/pg.js";
import { DEFAULT_CONSTRUCTION_VIDEO_ID, siteContentDefaults } from "../domain/siteContent.js";
import { siteContentSchema } from "../domain/schemas.js";

const MAX_CONSTRUCTION_PHOTOS = 24;
const MAX_CAPTION = 80;

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

// Mongoose filled missing sub-fields with schema defaults whenever a document was read.
const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);
const withDefaults = (doc) => {
  const defaults = siteContentDefaults();
  const out = { ...doc };
  for (const [section, def] of Object.entries(defaults)) {
    const v = doc[section];
    out[section] = isPlain(v) ? { ...def, ...v } : v === undefined || v === null ? { ...def } : v;
  }
  if (isPlain(out.navbar)) {
    out.navbar.customLink = isPlain(out.navbar.customLink)
      ? { ...defaults.navbar.customLink, ...out.navbar.customLink }
      : out.navbar.customLink === undefined || out.navbar.customLink === null
        ? { ...defaults.navbar.customLink }
        : out.navbar.customLink;
  }
  return out;
};

const getOrCreate = async () => {
  const existing = await siteContent.findOne({ key: "main" });
  if (existing) return withDefaults(existing);
  await siteContent.insert({ key: "main", ...siteContentDefaults() }, { onConflictDoNothing: true });
  return withDefaults(await siteContent.findOne({ key: "main" }));
};

const SECTIONS = ["hero", "about", "contact", "navbar", "festival"];

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
      const { hero, about, contact, navbar, festival, construction } = req.body;
      const patch = { updatedBy: req.user?.userId };
      if (hero) patch.hero = hero;
      if (about) patch.about = about;
      if (contact) patch.contact = contact;
      if (navbar) patch.navbar = navbar;
      if (festival) patch.festival = festival;

      if (construction) {
        const url = String(construction.videoUrl || "").trim();
        const videoId = parseYouTubeId(url);
        if (url && !videoId) {
          return res.status(400).json({
            message:
              "That doesn't look like a YouTube link. Paste the Share link from the video — e.g. https://youtube.com/shorts/XXXXXXXXXXX",
          });
        }
        // Dotted paths so the video and the photo gallery can be saved independently.
        patch["construction.videoUrl"] = url;
        patch["construction.videoId"] = videoId || DEFAULT_CONSTRUCTION_VIDEO_ID;
        patch["construction.updatedAt"] = new Date();

        if (Array.isArray(construction.photos)) {
          patch["construction.photos"] = construction.photos
            .map((p) => ({
              url: String(p?.url || "").trim(),
              caption: String(p?.caption || "")
                .trim()
                .slice(0, MAX_CAPTION),
            }))
            .filter((p) => p.url)
            .slice(0, MAX_CONSTRUCTION_PHOTOS);
        }
      }

      const cast = siteContentSchema.castUpdate(patch);
      await getOrCreate();

      const params = [];
      const bind = (v) => {
        params.push(v);
        return `$${params.length}`;
      };
      const sets = [];
      for (const name of SECTIONS) {
        if (name in cast) sets.push(`"${name}" = ${bind(JSON.stringify(cast[name]))}::jsonb`);
      }
      const constructionPatch = {};
      for (const [key, value] of Object.entries(cast)) {
        if (key.startsWith("construction.")) constructionPatch[key.slice("construction.".length)] = value;
      }
      if (Object.keys(constructionPatch).length) {
        sets.push(
          `construction = COALESCE(construction, '{}'::jsonb) || ${bind(JSON.stringify(constructionPatch))}::jsonb`
        );
      }
      if (cast.updatedBy) sets.push(`updated_by = ${bind(cast.updatedBy)}`);
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
