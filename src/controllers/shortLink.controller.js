const crypto = require("crypto");
const { shortLinkModel } = require("../models/shortLink.model");

// Short links for UTM campaign URLs (Admin → Donations → UTM Builder).
//   Public : GET /short-links/resolve/:code   -> { path }   (the website's /go/<code> page calls this, then redirects)
//   Admin  : GET /short-links, POST /short-links, DELETE /short-links/:id
//
// The destination is stored as a site-relative path + query. Addresses on other websites are refused, so a short
// link can never be used as an open redirect.

const SITE_HOSTS = new Set(
  ["harekrishnavizag.org", "www.harekrishnavizag.org", ...String(process.env.SHORT_LINK_EXTRA_HOSTS || "").split(",")]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);
const CODE_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BOT_RX = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|headless|curl|wget/i;

/** Returns "/page?query" for an address on this website (or a "/path" already), else "". */
function toSitePath(input) {
  const raw = String(input || "").trim();
  if (!raw || raw.length > 2000) return "";
  try {
    if (raw.startsWith("/") && !raw.startsWith("//")) {
      const u = new URL(raw, "https://site.invalid");
      return `${u.pathname}${u.search}`;
    }
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!SITE_HOSTS.has(u.hostname.toLowerCase())) return "";
    return `${u.pathname}${u.search}`;
  } catch {
    return "";
  }
}

const randomCode = () => crypto.randomBytes(5).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "x" + Date.now().toString(36);

const shortLinkController = {
  // PUBLIC — GET /short-links/resolve/:code
  resolve: async (req, res) => {
    try {
      const code = String(req.params.code || "").trim().toLowerCase().slice(0, 40);
      if (!CODE_RX.test(code)) return res.status(404).json({ message: "Not found" });
      const link = await shortLinkModel.findOne({ code }).lean();
      if (!link) return res.status(404).json({ message: "Not found" });
      // Count real visitors only: link-preview fetchers (WhatsApp, Facebook...) would otherwise inflate it.
      const ua = String(req.headers["x-visitor-ua"] || "");
      if (ua && !BOT_RX.test(ua)) {
        shortLinkModel.updateOne({ _id: link._id }, { $inc: { clicks: 1 }, $set: { lastClickAt: new Date() } }).catch(() => {});
      }
      res.set("Cache-Control", "no-store");
      return res.json({ path: link.path });
    } catch (err) {
      console.error("shortLink.resolve error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — GET /short-links
  list: async (_req, res) => {
    try {
      const items = await shortLinkModel.find().sort({ createdAt: -1 }).limit(500).lean();
      return res.json({ items });
    } catch (err) {
      console.error("shortLink.list error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — POST /short-links  { url, code?, label? }
  create: async (req, res) => {
    try {
      const b = req.body || {};
      const path = toSitePath(b.url);
      if (!path) return res.status(400).json({ message: "The link must be a page on harekrishnavizag.org." });

      let code = String(b.code || "").trim().toLowerCase();
      if (code) {
        if (code.length < 2 || code.length > 40 || !CODE_RX.test(code)) {
          return res.status(400).json({ message: "Short name can use only lowercase letters, numbers and dashes (2 to 40 characters)." });
        }
        if (await shortLinkModel.exists({ code })) return res.status(409).json({ message: `The short name "${code}" is already used.` });
      } else {
        for (let i = 0; i < 5 && !code; i++) {
          const c = randomCode();
          if (!(await shortLinkModel.exists({ code: c }))) code = c;
        }
        if (!code) return res.status(500).json({ message: "Couldn't make a short name. Try again." });
      }

      const link = await shortLinkModel.create({
        code,
        path,
        label: String(b.label || "").trim().slice(0, 120),
        createdBy: req.user && req.user._id,
      });
      return res.status(201).json({ link });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ message: "That short name is already used." });
      console.error("shortLink.create error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — DELETE /short-links/:id
  remove: async (req, res) => {
    try {
      if (!/^[0-9a-f]{24}$/i.test(String(req.params.id))) return res.status(404).json({ message: "Not found" });
      await shortLinkModel.deleteOne({ _id: req.params.id });
      return res.json({ message: "Deleted" });
    } catch (err) {
      console.error("shortLink.remove error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { shortLinkController, toSitePath };
