// src/services/pageBanner.service.js
//
// Works out which hero banner belongs to the page a donation came from, so the
// pending-payment WhatsApp reminder shows THAT page's banner as its header —
// a Pitru Paksha donor sees the Pitru Paksha banner, not Brick Seva.
//
// Two helpers live here:
//
//   sanitizeBannerImage(url) — used by createOrder to decide whether the
//       `bannerImage` a page sent with its order may be stored. Only images on
//       our own hosts are accepted (see ALLOWED_BANNER_SOURCES): the donor's
//       mobile number on an order is whatever was typed into the form, so an
//       open field would let anyone make our business number send an
//       arbitrary picture to an arbitrary phone.
//
//   fetchPageOgImage(page) — fallback for donations that carry no
//       bannerImage (records created before pages started sending it, or a
//       page that forgot to). Reads the og:image of the live page, which on
//       the festival pages is the desktop hero banner. Cached per page.

const { SITE_URL } = require("./pendingMessage.util");

// Hosts (and optional path prefixes) a stored banner may point at. Everything
// the media library uploads lives on the R2 public bucket; a few older pages
// still use the Cloudinary account; relative "/assets/…" paths are served by
// the site itself. Extend with PENDING_BANNER_ALLOWED_SOURCES (comma-separated
// "host" or "host/path-prefix" entries) without a code change.
const ALLOWED_BANNER_SOURCES = [
  "pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev",
  "res.cloudinary.com/ddmzeqpkc/",
  "harekrishnavizag.org",
  "www.harekrishnavizag.org",
  ...hostOf(process.env.R2_PUBLIC_URL),
  ...hostOf(SITE_URL),
  ...String(process.env.PENDING_BANNER_ALLOWED_SOURCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

function hostOf(url) {
  try {
    return url ? [new URL(url).host] : [];
  } catch {
    return [];
  }
}

const MAX_BANNER_URL_LENGTH = 600;

/** Makes "/assets/x.jpg" absolute against the site; leaves full URLs alone. */
function absolutize(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  return `${SITE_URL}${value.startsWith("/") ? "" : "/"}${value}`;
}

/**
 * The banner URL to store on a donation, or undefined when the value is
 * missing, malformed, or points anywhere other than our own image hosts.
 */
function sanitizeBannerImage(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > MAX_BANNER_URL_LENGTH) return undefined;

  // Site-relative paths ("/assets/…") are ours by definition.
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;

  const hostAndPath = `${parsed.host}${parsed.pathname}`;
  const allowed = ALLOWED_BANNER_SOURCES.some((source) =>
    source.includes("/") ? hostAndPath.startsWith(source) : parsed.host === source
  );
  return allowed ? value : undefined;
}

// ---------------------------------------------------------------------------
// og:image lookup
// ---------------------------------------------------------------------------

// Set PENDING_BANNER_LIVE_LOOKUP=false to stop the reminder job requesting
// pages from the live site.
const LIVE_LOOKUP_ENABLED = String(process.env.PENDING_BANNER_LIVE_LOOKUP || "true") !== "false";
const LOOKUP_TIMEOUT_MS = Number(process.env.PENDING_BANNER_LOOKUP_TIMEOUT_MS || 6000);
const HIT_TTL_MS = 6 * 60 * 60 * 1000; // a banner rarely changes within a day
const MISS_TTL_MS = 30 * 60 * 1000; // retry a failed page sooner

const OG_CACHE = new Map(); // page -> { url: string|null, expires: number }

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** First og:image (or twitter:image) in the page's HTML, or null. */
function extractOgImage(html) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const read = (tag, attr) => {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    return m ? decodeEntities(m[2] != null ? m[2] : m[3]) : "";
  };
  for (const wanted of ["og:image", "twitter:image"]) {
    for (const tag of tags) {
      const key = (read(tag, "property") || read(tag, "name")).toLowerCase();
      if (key === wanted) {
        const content = read(tag, "content").trim();
        if (content) return content;
      }
    }
  }
  return null;
}

/**
 * og:image of https://<site>/<page>, absolute, or null when the page can't be
 * read. Never throws.
 *
 * @param {string} page - base page path without leading slash, e.g. "pitru-paksha"
 */
async function fetchPageOgImage(page) {
  const path = String(page || "").replace(/^\/+|\/+$/g, "");
  // Only plain page paths — never anything that could steer the request
  // somewhere other than our own site.
  if (!LIVE_LOOKUP_ENABLED || !path || !/^[a-z0-9][a-z0-9\-_/]*$/i.test(path)) return null;

  const cached = OG_CACHE.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;

  let url = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${SITE_URL}/${path}`, {
      signal: controller.signal,
      headers: { "User-Agent": "HKMV-PendingReminder/1.0", Accept: "text/html" },
    });
    if (res.ok) {
      const found = extractOgImage(await res.text());
      url = found ? absolutize(found) : null;
    } else {
      console.warn(`[PageBanner] ${SITE_URL}/${path} returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[PageBanner] Could not read ${SITE_URL}/${path}:`, err && err.message ? err.message : err);
  } finally {
    clearTimeout(timer);
  }

  OG_CACHE.set(path, { url, expires: Date.now() + (url ? HIT_TTL_MS : MISS_TTL_MS) });
  return url;
}

module.exports = {
  sanitizeBannerImage,
  fetchPageOgImage,
  extractOgImage,
  absolutize,
  ALLOWED_BANNER_SOURCES,
};
