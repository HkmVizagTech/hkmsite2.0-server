// src/services/pendingReminder.service.js
//
// Pending-transaction WhatsApp reminder — mirrors the flow already running
// on the Annadana/Subhojanam site (sendPendingWhatsappReminders script +
// /api/internal/send-pending-reminders endpoint), adapted for this site's
// donation model and many sevas.
//
// A donation becomes "pending" here when the Razorpay order is created but
// the payment is not yet captured/confirmed (abandoned checkout, or payment
// still in progress). Once a pending donation is older than the cutoff
// (default 6 minutes, like Annadan) and we haven't already messaged the
// donor, we send the approved "pending transaction" WhatsApp template with
// that donation's own seva name — so one template covers every seva.
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

// Batch size per run — keeps each pass short and lets the schedule loop
// around to remaining records on later runs.
const BATCH_SIZE = Number(process.env.PENDING_REMINDER_BATCH_SIZE || 100);

// How many failed sends before a donation is left alone. The job marks a
// donation reminded only on a real success, so a permanently unsendable record
// would otherwise be retried every pass forever — and since the batch is
// ordered oldest-first with a fixed limit, a pile of them would crowd newer
// donations out of the batch. Their last error is kept on the record.
const MAX_ATTEMPTS = Number(process.env.PENDING_REMINDER_MAX_ATTEMPTS || 3);

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

  const cutoff = new Date(Date.now() - CUTOFF_MINUTES * 60 * 1000);

  const pendingDonations = await donationModel
    .find({
      status: "pending",
      createdAt: { $lte: cutoff },
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

  for (const donation of pendingDonations) {
    if (!donation.donorMobile) {
      // No phone on record — nothing to message; mark it so we don't re-check
      // this record forever on every pass.
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      continue;
    }

    try {
      await provider.send(
        donation.donorMobile,
        donation.donorName || "Devotee",
        donation.amount,
        donation.sevaName || donation.type || "your seva",
        {
          linkSuffix: resolveLinkSuffix(donation),
          sourcePage: donation.sourcePage,
          sevaImage: getSevaImage(donation),
        },
      );
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      sent += 1;
      console.log(
        `Pending reminder sent via ${provider.name} for donation`,
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
    checked: pendingDonations.length,
    sent,
    failed,
    cutoffMinutes: CUTOFF_MINUTES,
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
};
