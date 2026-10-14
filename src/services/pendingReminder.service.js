import { getPool } from "../db/pg.js";
import { donations, claimUpdate } from "../domain/donationDb.js";
import { isWhatsAppConfigured, sendPendingWhatsapp } from "./whatsapp.service.js";
import { isGupshupConfigured, sendPendingWhatsappViaGupshup, FALLBACK_HEADER_IMAGE } from "./gupshup.service.js";
import { sanitizeBannerImage, fetchPageOgImage, absolutize } from "./pageBanner.service.js";

const PROVIDER = String(process.env.PENDING_WHATSAPP_PROVIDER || "flaxxa").toLowerCase();

function resolveProvider() {
  if (PROVIDER === "gupshup") {
    return {
      name: "gupshup",
      configured: isGupshupConfigured(),
      reason: "gupshup_not_configured",
      send: sendPendingWhatsappViaGupshup,
    };
  }
  return {
    name: "flaxxa",
    configured: isWhatsAppConfigured(),
    reason: "whatsapp_not_configured",
    send: sendPendingWhatsapp,
  };
}

const CUTOFF_MINUTES = Number(process.env.PENDING_REMINDER_CUTOFF_MINUTES || 3);

const MAX_AGE_HOURS = Number(process.env.PENDING_REMINDER_MAX_AGE_HOURS || 24);

// Batch size per run — keeps each pass short and lets the schedule loop
// around to remaining records on later runs.
const BATCH_SIZE = Number(process.env.PENDING_REMINDER_BATCH_SIZE || 100);

const MAX_ATTEMPTS = Number(process.env.PENDING_REMINDER_MAX_ATTEMPTS || 3);

// Donation statuses that earn a reminder. Both get the same message.
// Override with a comma-separated PENDING_REMINDER_STATUSES if needed.
const REMINDER_STATUSES = String(process.env.PENDING_REMINDER_STATUSES || "pending,failed")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RETRY_GRACE_MINUTES = Number(process.env.PENDING_REMINDER_SKIP_IF_COMPLETED_WITHIN_MINUTES || 15);

// Mirrors SUCCESS_STATUSES in donationAdmin.controller.js.
const SUCCESS_STATUSES = ["completed"];

function mobileVariants(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return digits ? [String(raw), digits] : [];
  const last10 = digits.slice(-10);
  return [last10, `91${last10}`, `+91${last10}`, `0${last10}`, String(raw)];
}

async function donorAlreadyCompleted(donation) {
  if (!RETRY_GRACE_MINUTES || !donation.donorMobile) return false;

  const variants = mobileVariants(donation.donorMobile);
  if (!variants.length) return false;

  const since = new Date(new Date(donation.createdAt).getTime() - RETRY_GRACE_MINUTES * 60 * 1000);

  const completed = await donations.findOne(
    {
      _id: { $ne: donation._id },
      donorMobile: { $in: variants },
      status: { $in: SUCCESS_STATUSES },
      createdAt: { $gte: since },
    },
    { sort: { createdAt: 1, _id: 1 }, fields: ["amount", "sevaName", "createdAt"] }
  );

  return completed || false;
}

const R2 = "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/";

const SEVA_IMAGES = {
  "sqft-seva-campaign": R2 + "1786528614525-1786528613759-ChatGPTImageAug122026022735PM.webp",
  "brick-seva-campaign": R2 + "1785588189215-1785588187426-brick-hero-desk.webp",
  "anna-daan-seva": R2 + "1785586501452-1785586500800-annadan-banner-desk.webp",
  "gau-seva": R2 + "1785586948250-1785586945893-Gau-banner-desk.webp",
  "gita-daan-seva": R2 + "1786195248602-1786195247509-gita-hero-desk.webp",
  "alankara-vastra-seva": R2 + "1785573838202-1785573837372-ChatGPTImageAug12026021301PM.webp",
  // Subhojanam reuses the Annadana banner, per requirement.
  subhojanam: R2 + "1785586501452-1785586500800-annadan-banner-desk.webp",
  // All Janmashtami pages share the same banner.
  janmashtami: R2 + "1787055655171-1787055654678-janmashtami2banner.webp",
  janmashtami3: R2 + "1787055655171-1787055654678-janmashtami2banner.webp",
  "donations/janmashtami2": R2 + "1787055655171-1787055654678-janmashtami2banner.webp",
  // Festival pages — desktop hero banners, same as each page's DESKTOP_BANNER.
  "pitru-paksha": R2 + "1790235076658-1790235074922-pitru-paksha-desk.webp",
  radhashtami: R2 + "1788946765218-1788946764659-Radhashtamidesk.webp",
  "govardhan-puja": R2 + "1789476038584-1789476037499-govardhan-desk.webp",
  ekadashi: R2 + "1790154963930-1790154963675-ekadashidesk.webp",
  "shayani-ekadashi": R2 + "1790154963930-1790154963675-ekadashidesk.webp",
  chaturmas: R2 + "1786539472426-1786539471654-Chaturmasbanner.webp",
  vijayadashami: R2 + "1791881259236-1791881258272-Dussehradesk.webp",
  "special-occasion": R2 + "1784005845291-1784005844212-ChatGPTImageJul142026104033AM.png",
  // /donate/<seva> pages share the banner of the matching campaign page.
  "donate/square-foot-seva": R2 + "1786528614525-1786528613759-ChatGPTImageAug122026022735PM.webp",
  "donate/brick-seva": R2 + "1785588189215-1785588187426-brick-hero-desk.webp",
  "donate/anna-daan-seva": R2 + "1785586501452-1785586500800-annadan-banner-desk.webp",
  "donate/gau-seva": R2 + "1785586948250-1785586945893-Gau-banner-desk.webp",
  "donate/gita-daan-seva": R2 + "1786195248602-1786195247509-gita-hero-desk.webp",
  "donate/vastra-seva": R2 + "1785573838202-1785573837372-ChatGPTImageAug12026021301PM.webp",
};

const DEFAULT_SEVA_IMAGE =
  process.env.WAPI_PENDING_IMAGE || R2 + "1783677419371-1783677418690-DietyPhotos.jpeg" || FALLBACK_HEADER_IMAGE;

function baseSourcePage(sourcePage) {
  return String(sourcePage || "")
    .replace(/^\/+/, "")
    .replace(/\/c\/[^/]+$/, "")
    .replace(/\/+$/, "");
}

/** Static lookup only (steps 2 and 4) — kept for callers that can't await. */
function getSevaImage(donation) {
  const sourcePage = baseSourcePage(donation.sourcePage);
  return SEVA_IMAGES[sourcePage] || DEFAULT_SEVA_IMAGE;
}

async function resolveSevaImage(donation) {
  const stored = sanitizeBannerImage(donation.bannerImage);
  if (stored) return { url: absolutize(stored), source: "donation" };

  const page = baseSourcePage(donation.sourcePage);

  // 2. Known page.
  if (SEVA_IMAGES[page]) return { url: SEVA_IMAGES[page], source: "map" };

  // 3. The live page's og:image. Only for real page paths — not the
  //    "admin-manual" / backfill markers some records carry.
  if (page && !NON_PAGE_SOURCES.has(page)) {
    try {
      const live = await fetchPageOgImage(page);
      if (live) return { url: live, source: "live-page" };
    } catch {
      /* fall through to the neutral default */
    }
  }

  // 4. Neutral default.
  console.warn(
    `[PendingReminder] No banner found for sourcePage "${donation.sourcePage || ""}" —`,
    "using the neutral default. Send bannerImage with the order from that page."
  );
  return { url: DEFAULT_SEVA_IMAGE, source: "default" };
}

// sourcePage values that are markers, not pages on the site.
const NON_PAGE_SOURCES = new Set(["admin-manual", "recovered-subscription-backfill", "unknown"]);

const SEVA_LINK_SUFFIXES = [
  { types: ["SQFT"], keys: ["square foot", "square feet", "sq ft", "sqft"], path: "sqft-seva-campaign" },
  { types: ["BRICK"], keys: ["brick"], path: "brick-seva-campaign" },
  {
    types: ["ANNADAAN", "ANN", "ANNADANA"],
    keys: ["anna daan", "anna-daan", "annadaan", "annadana", "annadan"],
    path: "anna-daan-seva",
  },
  { types: ["GO SEVA", "GOSEVA"], keys: ["gau seva", "gau-seva", "go seva", "cow", "goshala"], path: "gau-seva" },
  {
    types: ["BD", "GITA"],
    keys: ["gita daan", "gita-daan", "gita dan", "gita", "bhagavad gita"],
    path: "gita-daan-seva",
  },
  { types: ["GDGD", "VASTRA"], keys: ["vastra", "alankara", "alankar"], path: "alankara-vastra-seva" },
];

const FESTIVAL_PAGES = new Set([
  "janmashtami",
  "janmashtami3",
  "donations/janmashtami2",
  "ekadashi",
  "shayani-ekadashi",
  "donations",
  "special-occasion",
  "subhojanam",
  "vijayadashami",
  "sqft-seva-campaign",
  "brick-seva-campaign",
  "pitru-paksha",
  "radhashtami",
  "govardhan-puja",
  "chaturmas",
]);

const CAMPAIGN_LABELS = {
  janmashtami: "Sri Krishna Janmashtami",
  janmashtami3: "Sri Krishna Janmashtami",
  "donations/janmashtami2": "Sri Krishna Janmashtami",
  ekadashi: "Ekadashi",
  "shayani-ekadashi": "Shayani Ekadashi", // legacy pending records only
  chaturmas: "Chaturmas",
  vijayadashami: "Vijayadashami",
  "special-occasion": "Special Occasion Seva",
};

function prettifySlug(slug) {
  return String(slug || "")
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveCampaignLabel(donation) {
  const basePage = baseSourcePage(donation.sourcePage);
  if (CAMPAIGN_LABELS[basePage]) return CAMPAIGN_LABELS[basePage];

  const slug = String(donation.festivalSlug || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return slug ? prettifySlug(slug) : "";
}

function resolveLinkSuffix(donation) {
  const basePage = baseSourcePage(donation.sourcePage);

  if (basePage && (FESTIVAL_PAGES.has(basePage) || String(donation.festivalSlug || "").trim())) {
    return basePage;
  }

  const typeStr = String(donation.type || "")
    .trim()
    .toUpperCase();
  const nameStr = String(donation.sevaName || "").toLowerCase();

  for (const mapping of SEVA_LINK_SUFFIXES) {
    const typeMatch = Array.isArray(mapping.types) && mapping.types.includes(typeStr);
    const keyMatch = Array.isArray(mapping.keys) && mapping.keys.some((k) => nameStr.includes(k));
    if (typeMatch || keyMatch) return mapping.path;
  }

  // Unknown seva — fall back to the page it came from so the donor still lands
  // on a place they can re-attempt the payment.
  return basePage || "donate";
}

const DEEP_LINK_PAGES = new Set(["janmashtami", "janmashtami3", "donations/janmashtami2"]);

const LEGACY_SEVA_SLUGS = {
  "annadana seva": "annadana",
  "gau seva": "gau-seva",
  "pushpalankara seva": "pushpalankara",
  "abhisheka seva": "abhisheka",
  "naivedhya seva": "naivedhya",
  "tulasi archana seva": "tulasi-archana",
  "makhan mishri seva": "makhan-mishri",
  "vastrabharana seva": "vastrabharana",
  "chappan bhog seva": "chappan-bhog",
  "mandapa seva": "mandapa",
  "japa yagna seva": "japa-yagna",
};

function normalizeSevaName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveSevaSlug(donation) {
  const stored = String(donation.sevaSlug || "").trim();
  if (stored) return stored;

  return LEGACY_SEVA_SLUGS[normalizeSevaName(donation.sevaName)] || "";
}

function resolveLinkQuery(donation, linkSuffix) {
  if (!DEEP_LINK_PAGES.has(linkSuffix)) return null;

  const seva = resolveSevaSlug(donation);
  if (!seva) return null;

  const query = { seva };

  const amount = Math.round(Number(donation.amount));
  if (Number.isFinite(amount) && amount >= 100) query.amount = String(amount);

  return query;
}

async function runPendingReminders() {
  const provider = resolveProvider();
  if (!provider.configured) {
    return { skipped: true, reason: provider.reason, provider: provider.name, checked: 0, sent: 0, failed: 0 };
  }

  const lockClient = await getPool().connect();
  try {
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('pending-reminders')) AS ok");
    if (!rows[0].ok) {
      return { skipped: true, reason: "already_running", provider: provider.name, checked: 0, sent: 0, failed: 0 };
    }
    try {
      return await runPass(provider);
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('pending-reminders'))").catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

const markReminded = (donation) =>
  claimUpdate(
    { _id: String(donation._id), whatsappPendingReminderSent: { $ne: true } },
    { whatsappPendingReminderSent: true }
  );

/** Donations due a reminder right now, oldest first. */
async function findReminderCandidates(cutoff, floor) {
  return donations.find(
    {
      status: { $in: REMINDER_STATUSES },
      createdAt: { $lte: cutoff, $gte: floor },
      whatsappPendingReminderSent: { $ne: true },
      // Give up on records that have already failed MAX_ATTEMPTS times.
      whatsappPendingReminderAttempts: { $lt: MAX_ATTEMPTS },
      // Recurring first-charges stay "pending" until the subscription activates.
      isRecurring: { $ne: true },
      // PhonePe / UPI fallback opened or claimed: an admin is matching it.
      "upiFallback.status": { $nin: ["opened", "claimed", "matched"] },
    },
    { sort: { createdAt: 1, _id: 1 }, limit: BATCH_SIZE }
  );
}

async function runPass(provider) {
  const now = Date.now();
  // Old enough to have genuinely stalled...
  const cutoff = new Date(now - CUTOFF_MINUTES * 60 * 1000);
  // ...but recent enough that the donor still remembers making the attempt.
  const floor = new Date(now - MAX_AGE_HOURS * 60 * 60 * 1000);

  const pendingDonations = await findReminderCandidates(cutoff, floor);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const donation of pendingDonations) {
    if (!donation.donorMobile) {
      // No phone on record — mark it so we don't re-check this record forever.
      await markReminded(donation);
      continue;
    }

    // Superseded retry — this donor's money already went through.
    const completedInstead = await donorAlreadyCompleted(donation);
    if (completedInstead) {
      await markReminded(donation);
      skipped += 1;
      console.log(
        `Pending reminder skipped for ${donation.status} donation ${String(donation._id)} —`,
        `donor completed donation ${String(completedInstead._id)} instead`
      );
      continue;
    }

    const linkSuffix = resolveLinkSuffix(donation);
    const banner = await resolveSevaImage(donation);

    try {
      await provider.send(
        donation.donorMobile,
        donation.donorName || "Donor",
        donation.amount,
        donation.sevaName || donation.type || "your seva",
        {
          linkSuffix,
          linkQuery: resolveLinkQuery(donation, linkSuffix),
          sourcePage: donation.sourcePage,
          sevaImage: banner.url,
          campaignLabel: resolveCampaignLabel(donation),
        }
      );
      await markReminded(donation);
      sent += 1;
      console.log(
        `Pending reminder sent via ${provider.name} for ${donation.status} donation`,
        String(donation._id),
        "->",
        donation.donorMobile,
        `(banner: ${banner.source})`
      );
    } catch (err) {
      failed += 1;
      const message = err && err.message ? err.message : String(err);
      try {
        await donations.updateById(donation._id, {
          $inc: { whatsappPendingReminderAttempts: 1 },
          whatsappPendingReminderError: message.slice(0, 500),
        });
      } catch (saveErr) {
        console.error("Could not record reminder failure for donation", String(donation._id), saveErr.message);
      }
      console.error(
        `Pending reminder failed via ${provider.name} for donation`,
        String(donation._id),
        err && err.response && err.response.data
          ? JSON.stringify(err.response.data)
          : err && err.message
            ? err.message
            : err
      );
    }
  }

  return {
    provider: provider.name,
    statuses: REMINDER_STATUSES,
    checked: pendingDonations.length,
    sent,
    failed,
    skipped,
    cutoffMinutes: CUTOFF_MINUTES,
    maxAgeHours: MAX_AGE_HOURS,
    window: { from: floor.toISOString(), to: cutoff.toISOString() },
  };
}

export {
  runPendingReminders,
  findReminderCandidates,
  SEVA_IMAGES,
  DEFAULT_SEVA_IMAGE,
  getSevaImage,
  resolveSevaImage,
  resolveLinkSuffix,
  CAMPAIGN_LABELS,
  resolveCampaignLabel,
  DEEP_LINK_PAGES,
  resolveSevaSlug,
  resolveLinkQuery,
};
