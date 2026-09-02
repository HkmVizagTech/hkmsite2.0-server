// src/services/pendingReminder.service.js
//
// Pending-transaction WhatsApp reminder — mirrors the flow already running
// on the Annadana/Subhojanam site (sendPendingWhatsappReminders script +
// /api/internal/send-pending-reminders endpoint), adapted for this site's
// donation model and many sevas.
//
// Two kinds of donation get the nudge, both with the identical "pending"
// wording (donors don't need the distinction, and it keeps one approved
// template covering everything):
//   "pending" — the Razorpay order was created but never captured: an
//               abandoned checkout, or a payment still in progress.
//   "failed"  — Razorpay sent payment.failed for the order and no capture was
//               found (see payment.controller.js). The donor tried and the
//               payment did not go through, so the nudge is if anything more
//               useful here than for an abandoned checkout.
// Once such a donation is older than the cutoff (default 6 minutes, like
// Annadan) and we haven't already messaged the donor, we send the approved
// "pending transaction" WhatsApp template with that donation's own seva name.
//
// The whatsappPendingReminderSent flag makes this idempotent: it is set only
// after a successful send, so overlapping runs (in-process scheduler + an
// external cron hitting the internal endpoint) can never double-message.

const { donationModel } = require("../models/donation.model");
const {
  isWhatsAppConfigured,
  sendPendingWhatsapp,
} = require("./whatsapp.service");
const {
  isGupshupConfigured,
  sendPendingWhatsappViaGupshup,
} = require("./gupshup.service");

// Which BSP sends the pending reminder.
//
//   "flaxxa"  (default) — the main +91… business number. Its template button
//              URL has to be static because Flaxxa cannot fill a {{1}} in a
//              button link, so the seva link is written into the body text.
//   "gupshup"          — the 917075176108 number. Gupshup DOES fill dynamic
//              URL buttons, so the reminder keeps its per-seva
//              "Transaction Link" button. Needs GUPSHUP_API_KEY,
//              GUPSHUP_APP_NAME and GUPSHUP_PENDING_TEMPLATE_ID.
//
// Switch with PENDING_WHATSAPP_PROVIDER once the Gupshup template is approved.
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

// How old a pending donation must be before we nudge the donor (6 minutes —
// enough for UPI/auto-debit flows to settle or fail visibly, and for the
// donor to have genuinely abandoned an in-progress checkout).
const CUTOFF_MINUTES = Number(process.env.PENDING_REMINDER_CUTOFF_MINUTES || 6);

// ...and how old is TOO old. Without this floor, the very first run after
// deploy would sweep up every pending/failed donation ever recorded and
// message donors about attempts they abandoned months ago. It also keeps the
// job sane in steady state: a nudge about a checkout from last week is noise,
// not a reminder. Anything older than this is ignored permanently — it never
// becomes eligible again, so nothing accumulates waiting to be released.
const MAX_AGE_HOURS = Number(process.env.PENDING_REMINDER_MAX_AGE_HOURS || 24);

// Batch size per run — keeps each pass short and lets the schedule loop
// around to remaining records on later runs.
const BATCH_SIZE = Number(process.env.PENDING_REMINDER_BATCH_SIZE || 100);

// How many failed sends before a donation is left alone. The job marks a
// donation reminded only on a real success, so a permanently unsendable record
// would otherwise be retried every pass forever — and since the batch is
// ordered oldest-first with a fixed limit, a pile of them would crowd newer
// donations out of the batch. Their last error is kept on the record.
const MAX_ATTEMPTS = Number(process.env.PENDING_REMINDER_MAX_ATTEMPTS || 3);

// Donation statuses that earn a reminder. Both get the same message.
// Override with a comma-separated PENDING_REMINDER_STATUSES if needed.
const REMINDER_STATUSES = String(process.env.PENDING_REMINDER_STATUSES || "pending,failed")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// A donor whose payment fails or stalls usually retries straight away, and
// each attempt creates its OWN donation record — so the failed record lingers
// while the retry succeeds. Telling someone "your transaction of Rs.2100 is
// pending" minutes after their money actually went through is worse than
// saying nothing: it reads as "your payment did not work", and some donors
// will pay a second time.
//
// So immediately before each send we re-check the database: has this mobile
// number completed a donation since it made this attempt? If yes, stay quiet.
//
// The lookback grace covers the case where the successful payment is recorded
// a little BEFORE the stalled record's own timestamp (clock skew, or a webhook
// landing out of order). It is deliberately small: a wide window would
// suppress legitimate reminders for regular donors, who by definition have
// completed donations in their history. Set to 0 to disable the check.
const RETRY_GRACE_MINUTES = Number(
  process.env.PENDING_REMINDER_SKIP_IF_COMPLETED_WITHIN_MINUTES || 15
);

// Mirrors SUCCESS_STATUSES in donationAdmin.controller.js.
const SUCCESS_STATUSES = ["completed"];

// donorMobile is stored as the donor typed it, so the same person can appear
// as "9951141915", "919951141915" or "+91 99511 41915" across attempts.
// Match on the common variants of the last 10 digits — exact values rather
// than a suffix regex, so the donorMobile index is still usable.
function mobileVariants(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return digits ? [String(raw), digits] : [];
  const last10 = digits.slice(-10);
  return [last10, `91${last10}`, `+91${last10}`, `0${last10}`, String(raw)];
}

/**
 * True when this donor has already completed a donation since making this
 * attempt — i.e. the pending/failed record is a superseded retry and the
 * money is in.
 */
async function donorAlreadyCompleted(donation) {
  if (!RETRY_GRACE_MINUTES || !donation.donorMobile) return false;

  const variants = mobileVariants(donation.donorMobile);
  if (!variants.length) return false;

  const since = new Date(
    new Date(donation.createdAt).getTime() - RETRY_GRACE_MINUTES * 60 * 1000
  );

  const completed = await donationModel
    .findOne({
      _id: { $ne: donation._id },
      donorMobile: { $in: variants },
      status: { $in: SUCCESS_STATUSES },
      createdAt: { $gte: since },
    })
    .select("_id amount sevaName createdAt")
    .lean();

  return completed || false;
}

// Desktop banner image shown as the WhatsApp template header, keyed by the
// donation's base sourcePage (see baseSourcePage). If a page has no dedicated
// image here, the generic WAPI_PENDING_IMAGE default (or no header) is used.
const R2 = "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/";

const SEVA_IMAGES = {
  "sqft-seva-campaign": R2 + "1786528614525-1786528613759-ChatGPTImageAug122026022735PM.webp",
  "brick-seva-campaign": R2 + "1785588189215-1785588187426-brick-hero-desk.webp",
  "anna-daan-seva": R2 + "1785586501452-1785586500800-annadan-banner-desk.webp",
  "gau-seva": R2 + "1785586948250-1785586945893-Gau-banner-desk.webp",
  "gita-daan-seva": R2 + "1786195248602-1786195247509-gita-hero-desk.webp",
  "alankara-vastra-seva": R2 + "1785573838202-1785573837372-ChatGPTImageAug12026021301PM.webp",
  // Subhojanam reuses the Annadana banner, per requirement.
  "subhojanam": R2 + "1785586501452-1785586500800-annadan-banner-desk.webp",
  // All Janmashtami pages share the same banner.
  "janmashtami": R2 + "1787055655171-1787055654678-janmashtami2banner.webp",
  "janmashtami3": R2 + "1787055655171-1787055654678-janmashtami2banner.webp",
  "donations/janmashtami2": R2 + "1787055655171-1787055654678-janmashtami2banner.webp",
};

// Generic fallback header image when no mapping matches.
//
// This must NOT be empty: pending_seva_notice has an IMAGE header, and Meta
// rejects the entire send with "(#131008) Required parameter is missing" when
// no header media is supplied. Point WAPI_PENDING_IMAGE at a neutral temple
// banner if this one isn't the right generic.
const DEFAULT_SEVA_IMAGE =
  process.env.WAPI_PENDING_IMAGE ||
  R2 + "1785588189215-1785588187426-brick-hero-desk.webp";

// Reduces a sourcePage to its base page so campaigner/deep-link variants map
// to the same banner as their parent page, e.g. "/janmashtami/c/xyz" ->
// "janmashtami", "/sqft-seva-campaign/c/xyz" -> "sqft-seva-campaign".
function baseSourcePage(sourcePage) {
  return String(sourcePage || "").replace(/^\/+/, "").replace(/\/c\/[^/]+$/, "").replace(/\/+$/, "");
}

function getSevaImage(donation) {
  const sourcePage = baseSourcePage(donation.sourcePage);
  return SEVA_IMAGES[sourcePage] || DEFAULT_SEVA_IMAGE;
}

// The 6 core sevas map their donation category and seva-name keywords to the
// seva's dedicated campaign page. We use this for the footer button so a
// pending donation for (say) Brick Seva points at /brick-seva-campaign
// instead of a generic page.
const SEVA_LINK_SUFFIXES = [
  { types: ["SQFT"], keys: ["square foot", "square feet", "sq ft", "sqft"], path: "sqft-seva-campaign" },
  { types: ["BRICK"], keys: ["brick"], path: "brick-seva-campaign" },
  { types: ["ANNADAAN", "ANN", "ANNADANA"], keys: ["anna daan", "anna-daan", "annadaan", "annadana", "annadan"], path: "anna-daan-seva" },
  { types: ["GO SEVA", "GOSEVA"], keys: ["gau seva", "gau-seva", "go seva", "cow", "goshala"], path: "gau-seva" },
  { types: ["BD", "GITA"], keys: ["gita daan", "gita-daan", "gita dan", "gita", "bhagavad gita"], path: "gita-daan-seva" },
  { types: ["GDGD", "VASTRA"], keys: ["vastra", "alankara", "alankar"], path: "alankara-vastra-seva" },
];

// Source pages that are festival / standalone campaign pages. These keep their
// own link in the reminder even when the seva name resembles a core seva, so a
// Janmashtami "Vastrabharana" donation returns to Janmashtami, not the
// standalone Vastra campaign.
const FESTIVAL_PAGES = new Set([
  "janmashtami",
  "janmashtami3",
  "donations/janmashtami2",
  "shayani-ekadashi",
  "special-occasion",
  "subhojanam",
  "sqft-seva-campaign",
  "brick-seva-campaign",
]);

// Human-readable campaign name for the festival pages, keyed by base
// sourcePage. This is what turns a bare "Abhisheka Seva" in the reminder into
// "Abhisheka Seva (Sri Krishna Janmashtami)" — festival seva names are generic
// enough that a donor who abandoned a checkout during a festival will not
// place them without the occasion.
//
// Only festival pages belong here. On the 6 core seva pages the seva name IS
// the campaign ("Brick Seva" on /brick-seva-campaign), so a label there would
// only repeat itself — and buildPendingFields would drop it anyway.
const CAMPAIGN_LABELS = {
  janmashtami: "Sri Krishna Janmashtami",
  janmashtami3: "Sri Krishna Janmashtami",
  "donations/janmashtami2": "Sri Krishna Janmashtami",
  "shayani-ekadashi": "Shayani Ekadashi",
  chaturmas: "Chaturmas",
  "special-occasion": "Special Occasion Seva",
};

// "sri-krishna-janmashtami" -> "Sri Krishna Janmashtami". Used for the
// festivalSlug fallback below, so the label is presentable even when nobody
// remembered to add the page to CAMPAIGN_LABELS.
function prettifySlug(slug) {
  return String(slug || "")
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The festival/campaign to name in the reminder, or "" for pages that don't
 * need one.
 *
 * Falls back to the donation's own festivalSlug so a festival page added after
 * this file was last edited still gets context automatically. That fallback is
 * self-limiting in exactly the right way: only the festival pages send
 * festivalSlug with their order (janmashtami x3 and chaturmas today), so the
 * core seva pages stay unlabelled without needing an exclusion list.
 */
function resolveCampaignLabel(donation) {
  const basePage = baseSourcePage(donation.sourcePage);
  if (CAMPAIGN_LABELS[basePage]) return CAMPAIGN_LABELS[basePage];

  const slug = String(donation.festivalSlug || "").trim().replace(/^\/+|\/+$/g, "");
  return slug ? prettifySlug(slug) : "";
}

// Resolves the footer button path for a donation. Festival/campaign pages keep
// their own link (so a Janmashtami donation returns to Janmashtami, not a
// standalone seva). Otherwise, a match on one of the 6 core sevas maps to that
// seva's campaign page; anything unknown falls back to the sourcePage.
function resolveLinkSuffix(donation) {
  const basePage = baseSourcePage(donation.sourcePage);

  // Festival / standalone campaign pages — always keep their own link so the
  // donor returns to the page they originated from.
  if (FESTIVAL_PAGES.has(basePage)) return basePage;

  const typeStr = String(donation.type || "").trim().toUpperCase();
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

// Pages whose checkout understands ?seva=<slug>&amount=<rupees> and will open
// pre-filled. Keyed by the resolved link path (what the donor is actually sent
// to), not the sourcePage. A page missing from this set still gets a working
// bare link — the deep link is an enhancement, never a requirement.
const DEEP_LINK_PAGES = new Set(["janmashtami", "janmashtami3", "donations/janmashtami2"]);

// Fallback title -> slug map for the Janmashtami sevas, used only for
// donations created BEFORE the pages started sending sevaSlug with the order.
// New donations carry their own slug and never reach this table, so it does
// not need maintaining as sevas change year to year — it only has to keep
// matching the backlog of pending records still inside the 24h window.
//
// Keys are normalized (lowercase, punctuation collapsed to single spaces).
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

/**
 * The seva's slug on its page, or "" when we can't establish one.
 *
 * Prefers the slug stored on the donation at order time — that is the exact
 * value the page matches on, and survives a seva being renamed. Falls back to
 * the title map above for records created before that field existed.
 */
function resolveSevaSlug(donation) {
  const stored = String(donation.sevaSlug || "").trim();
  if (stored) return stored;

  return LEGACY_SEVA_SLUGS[normalizeSevaName(donation.sevaName)] || "";
}

/**
 * Deep-link params for the reminder's link, or null when this donation's page
 * can't use them. Returning null (rather than a partial query) is what keeps
 * every other page's link exactly as it is today.
 */
function resolveLinkQuery(donation, linkSuffix) {
  if (!DEEP_LINK_PAGES.has(linkSuffix)) return null;

  const seva = resolveSevaSlug(donation);
  if (!seva) return null;

  const query = { seva };

  // Restore the amount too, so the donor's only remaining step is to pay. 100
  // is the page's own minimum — below it the page would reject the value, so
  // it is better to let the donor pick again than to pre-fill something the
  // form refuses.
  const amount = Math.round(Number(donation.amount));
  if (Number.isFinite(amount) && amount >= 100) query.amount = String(amount);

  return query;
}

/**
 * Finds pending donations that are old enough and un-reminded, sends each one
 * the pending-transaction WhatsApp message, and marks whatsappPendingReminderSent.
 *
 * Never throws for individual failures — a bad phone number or a Flaxxa error
 * on one donation must not stop the rest of the batch (same as Annadan).
 *
 * @returns {Promise<{skipped?: boolean, reason?: string, checked: number, sent: number, failed: number}>}
 */
async function runPendingReminders() {
  const provider = resolveProvider();
  if (!provider.configured) {
    return { skipped: true, reason: provider.reason, provider: provider.name, checked: 0, sent: 0, failed: 0 };
  }

  const now = Date.now();
  // Old enough to have genuinely stalled...
  const cutoff = new Date(now - CUTOFF_MINUTES * 60 * 1000);
  // ...but recent enough that the donor still remembers making the attempt.
  const floor = new Date(now - MAX_AGE_HOURS * 60 * 60 * 1000);

  const pendingDonations = await donationModel
    .find({
      status: { $in: REMINDER_STATUSES },
      createdAt: { $lte: cutoff, $gte: floor },
      whatsappPendingReminderSent: { $ne: true },
      // Give up on records that have already failed MAX_ATTEMPTS times.
      // ($lt alone would not match documents predating this field.)
      $or: [
        { whatsappPendingReminderAttempts: { $exists: false } },
        { whatsappPendingReminderAttempts: { $lt: MAX_ATTEMPTS } },
      ],
      // Skip recurring/subscription first-charges — those stay "pending"
      // until the subscription activates, and the donor already authorised
      // autopay, so a "donation not confirmed" nudge would be wrong here.
      isRecurring: { $ne: true },
    })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const donation of pendingDonations) {
    if (!donation.donorMobile) {
      // No phone on record — nothing to message; mark it so we don't re-check
      // this record forever on every pass.
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      continue;
    }

    // Superseded retry — this donor's money already went through, so a
    // "still pending" message would only confuse them into paying twice.
    const completedInstead = await donorAlreadyCompleted(donation);
    if (completedInstead) {
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      skipped += 1;
      console.log(
        `Pending reminder skipped for ${donation.status} donation ${String(donation._id)} —`,
        `donor completed donation ${String(completedInstead._id)} instead`,
      );
      continue;
    }

    const linkSuffix = resolveLinkSuffix(donation);

    try {
      await provider.send(
        donation.donorMobile,
        donation.donorName || "Devotee",
        donation.amount,
        donation.sevaName || donation.type || "your seva",
        {
          linkSuffix,
          linkQuery: resolveLinkQuery(donation, linkSuffix),
          sourcePage: donation.sourcePage,
          sevaImage: getSevaImage(donation),
          campaignLabel: resolveCampaignLabel(donation),
        },
      );
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      sent += 1;
      console.log(
        `Pending reminder sent via ${provider.name} for ${donation.status} donation`,
        String(donation._id),
        "->",
        donation.donorMobile,
      );
    } catch (err) {
      failed += 1;
      const message = err && err.message ? err.message : String(err);
      donation.whatsappPendingReminderAttempts = (donation.whatsappPendingReminderAttempts || 0) + 1;
      donation.whatsappPendingReminderError = message.slice(0, 500);
      try {
        await donation.save();
      } catch (saveErr) {
        console.error("Could not record reminder failure for donation", String(donation._id), saveErr.message);
      }
      console.error(
        `Pending reminder failed via ${provider.name} for donation`,
        String(donation._id),
        err && err.response && err.response.data
          ? JSON.stringify(err.response.data)
          : (err && err.message ? err.message : err),
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

module.exports = {
  runPendingReminders,
  // Exported for warm-seva-banners.js, which pre-converts every banner to JPEG
  // so no donor's reminder is the first to pay that cost (or to hit the
  // generic-banner fallback because R2 was misconfigured).
  SEVA_IMAGES,
  DEFAULT_SEVA_IMAGE,
  getSevaImage,
  resolveLinkSuffix,
  CAMPAIGN_LABELS,
  resolveCampaignLabel,
  DEEP_LINK_PAGES,
  resolveSevaSlug,
  resolveLinkQuery,
};
