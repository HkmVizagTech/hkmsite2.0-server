const { siteContentModel } = require("../models/siteContent.model");

// Matches the schema default in siteContent.model.js — used when an admin
// clears the field, so the section always has a video rather than an empty
// frame. (Mongoose defaults apply when a document is created, not when a
// subdocument is later replaced, so this has to be explicit here.)
const DEFAULT_CONSTRUCTION_VIDEO_ID = "mPAt0gb__Hw";

/**
 * Pulls the 11-character video id out of any YouTube link an admin is likely
 * to paste. Shorts are what this is really for — the temple's monthly update
 * is filmed vertically and shared from the YouTube app, which gives a
 * /shorts/ link — but the same field accepts a normal watch URL, a youtu.be
 * share link, an embed URL, or the bare id, so nobody has to think about it.
 *
 * Returns null when nothing recognisable is in there, which the caller turns
 * into a clear error rather than silently saving a link that renders nothing.
 */
const parseYouTubeId = (raw) => {
  const input = String(raw || "").trim();
  if (!input) return null;

  // A bare id pasted on its own.
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

const siteContentController = {
  // PUBLIC - fetch site content (creates the default singleton on first read)
  get: async (req, res) => {
    try {
      let content = await siteContentModel.findOne({ key: "main" });
      if (!content) {
        content = await siteContentModel.create({ key: "main" });
      }
      res.status(200).json({ content });
    } catch (err) {
      console.error("Site content get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - update any subset of hero/about/contact/navbar
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
        // Refuse rather than store something the page can't play. The admin
        // finds out here, while they're looking at the form, instead of the
        // section silently going blank for every visitor.
        if (url && !videoId) {
          return res.status(400).json({
            message:
              "That doesn't look like a YouTube link. Paste the Share link from the video — e.g. https://youtube.com/shorts/XXXXXXXXXXX",
          });
        }
        patch.construction = {
          videoUrl: url,
          videoId: videoId || DEFAULT_CONSTRUCTION_VIDEO_ID,
          updatedAt: new Date(),
        };
      }

      const content = await siteContentModel.findOneAndUpdate(
        { key: "main" },
        { $set: patch },
        { new: true, upsert: true }
      );
      res.status(200).json({ message: "Content updated", content });
    } catch (err) {
      console.error("Site content update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { siteContentController };
