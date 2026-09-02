// src/services/gupshup.service.js
//
// Gupshup WhatsApp sender for the pending-transaction reminder.
//
// WHY THIS EXISTS
// Flaxxa's API cannot supply a value for a template's dynamic URL button
// ({{1}} at the end of the button link) — verified exhaustively against the
// live API; every send of such a template comes back with a null wamid and
// Meta's "(#131008) Required parameter is missing". Gupshup does support it,
// so the pending reminder can be sent from the Gupshup number instead and
// keep its per-seva "Transaction Link" button.
//
// GUPSHUP API CONTRACT (self-serve / non-partner)
//   POST https://api.gupshup.io/wa/api/v1/template/msg
//   Header: apikey: <GUPSHUP_API_KEY>          (NOT a bearer token)
//   Content-Type: application/x-www-form-urlencoded
//   Fields:
//     channel      = "whatsapp"
//     source       = sender number, bare digits, no "+"
//     destination  = recipient, bare digits, no "+"
//     src.name     = the Gupshup app name
//     template     = {"id":"<template uuid>","params":[...]}   (JSON string)
//     message      = {"type":"image","image":{"link":"..."}}   (JSON string, media header only)
//
//   * `params` is POSITIONAL: params[0] fills {{1}}, params[1] fills {{2}}, …
//   * A dynamic URL button's value is appended to the END of that same array,
//     after the last body variable. Gupshup's own CTA example does exactly
//     this: params: ["John", "docs/bot-platform/guide/whatsapp-api-documentation"].
//   * The media header is NOT part of `params` — it goes in the separate
//     `message` field. Putting it in params inflates the count and Gupshup
//     rejects the send.
//   * Unlike Flaxxa, the header image IS fetched from a link — but Meta only
//     accepts image/jpeg and image/png, and the seva banners in R2 are .webp,
//     so resolveJpegHeaderUrl() below converts and re-hosts them once.
//
// Success looks like {"status":"submitted","messageId":"..."} — anything else
// (or a missing messageId) is treated as a failure and throws, deliberately:
// the Flaxxa integration silently marked donations as reminded for messages
// that Meta had rejected, and that must not happen again here.

const crypto = require("crypto");
const { buildPendingFields } = require("./pendingMessage.util");
const { normalizePhone } = require("./whatsapp.service");

const GUPSHUP_TEMPLATE_URL = "https://api.gupshup.io/wa/api/v1/template/msg";

// The Gupshup sender is a different WhatsApp number from the Flaxxa one.
const SOURCE_NUMBER = process.env.GUPSHUP_SOURCE_NUMBER || "917075176108";

// Approved-on-Gupshup pending-transaction template.
//   name           pending_transaction_hkm
//   type           MEDIA (image header) / UTILITY / language En
//   Gupshup UUID   f12a709c-bc1f-429b-84d5-1262bc01a73c   <- what this API wants
//   Facebook id    3598241980329839                       <- Meta's own id, not used here
//   body           {{1}} name, {{2}} amount, {{3}} seva (with its campaign in
//                  brackets on festival pages), {{4}} allocation sentence
//   button         Visit Website "Transaction Link" -> https://www.harekrishnavizag.org/{{1}}
//
// The button's {{1}} is numbered independently of the body's variables; in the
// wire format it is simply the 5th and last entry of the params array.
const PENDING_TEMPLATE_ID = () =>
  process.env.GUPSHUP_PENDING_TEMPLATE_ID || "f12a709c-bc1f-429b-84d5-1262bc01a73c";

// Header image used when a seva banner cannot be converted to JPEG (R2
// unreachable or unconfigured). This is the PNG uploaded as the template's own
// approved sample, already hosted by Gupshup — Meta accepts it, so a reminder
// still goes out with a generic banner instead of failing outright.
const FALLBACK_HEADER_IMAGE =
  process.env.GUPSHUP_FALLBACK_HEADER_IMAGE ||
  "https://fss.gupshup.io/0/public/0/0/gupshup/917075176108/a295be41-efdc-4a25-8e3b-94188f18781e/1787982596334_ChatGPT%20Image%20Aug%2018%2C%202026%2C%2005_47_34%20PM.png";

// Set to "false" if the approved template's button URL turns out to be static
// after all — then no trailing param is appended.
const SEND_BUTTON_PARAM = () => String(process.env.GUPSHUP_PENDING_BUTTON_PARAM || "true") !== "false";

const isGupshupConfigured = () =>
  Boolean(process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_APP_NAME && PENDING_TEMPLATE_ID());

// ---------------------------------------------------------------------------
// Header image: Meta accepts only image/jpeg and image/png from the link, and
// the seva banners are .webp. Convert once, re-host on R2 under a key derived
// from the source URL, and reuse it forever after. A HEAD request to the
// public URL avoids re-uploading on every process restart.
// ---------------------------------------------------------------------------

const JPEG_URL_CACHE = new Map();

function isMetaSafeImageUrl(url) {
  return /\.(jpe?g|png)(\?|#|$)/i.test(String(url || ""));
}

async function resolveJpegHeaderUrl(sourceUrl) {
  if (!sourceUrl) return null;
  if (isMetaSafeImageUrl(sourceUrl)) return sourceUrl;
  if (JPEG_URL_CACHE.has(sourceUrl)) return JPEG_URL_CACHE.get(sourceUrl);

  const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  const hash = crypto.createHash("sha1").update(sourceUrl).digest("hex").slice(0, 16);
  const key = `whatsapp-headers/${hash}.jpg`;

  // Already converted on a previous run?
  if (publicBase) {
    const candidate = `${publicBase}/${key}`;
    try {
      const head = await fetch(candidate, { method: "HEAD" });
      if (head.ok) {
        JPEG_URL_CACHE.set(sourceUrl, candidate);
        return candidate;
      }
    } catch {
      /* fall through to convert + upload */
    }
  }

  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${sourceUrl}`);
    const input = Buffer.from(await res.arrayBuffer());

    const sharp = require("sharp");
    const jpeg = await sharp(input)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const { r2Client, bucketName } = require("../config/R2.config");
    await r2Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: jpeg,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      })
    );

    const finalUrl = `${publicBase}/${key}`;
    JPEG_URL_CACHE.set(sourceUrl, finalUrl);
    return finalUrl;
  } catch (err) {
    // Don't take the whole reminder down over a banner, and don't hand Gupshup
    // a .webp either — it rejects those outright, so the donor would get
    // nothing at all. Fall back to the template's own approved sample image
    // (a PNG that Gupshup already hosts): a generic banner beats no message.
    console.warn(
      "[Gupshup] Could not convert header image to JPEG, falling back to the default banner:",
      err && err.message ? err.message : err
    );
    return FALLBACK_HEADER_IMAGE;
  }
}

// ---------------------------------------------------------------------------

/**
 * Low-level Gupshup template send.
 *
 * @param {object} input
 * @param {string} input.phone - recipient, any format
 * @param {string} input.templateId - approved template UUID from the Gupshup console
 * @param {string[]} input.params - positional variables ({{1}}…) plus, last,
 *   the dynamic URL button's value if the template has one
 * @param {string} [input.headerImageUrl] - public jpeg/png URL for a media header
 */
async function sendGupshupTemplate({ phone, templateId, params, headerImageUrl }) {
  const apiKey = process.env.GUPSHUP_API_KEY;
  const appName = process.env.GUPSHUP_APP_NAME;
  if (!apiKey) throw new Error("GUPSHUP_API_KEY is not set");
  if (!appName) throw new Error("GUPSHUP_APP_NAME is not set");
  if (!templateId) throw new Error("No Gupshup template id supplied (set GUPSHUP_PENDING_TEMPLATE_ID)");

  const destination = normalizePhone(phone);
  if (!destination) throw new Error("Invalid or missing phone number");

  const form = new URLSearchParams();
  form.append("channel", "whatsapp");
  form.append("source", String(SOURCE_NUMBER).replace(/\D/g, ""));
  form.append("destination", destination);
  form.append("src.name", appName);
  form.append("template", JSON.stringify({ id: templateId, params }));
  if (headerImageUrl) {
    form.append("message", JSON.stringify({ type: "image", image: { link: headerImageUrl } }));
  }

  const response = await fetch(GUPSHUP_TEMPLATE_URL, {
    method: "POST",
    headers: { apikey: apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  const submitted = data && (data.status === "submitted" || Boolean(data.messageId));
  if (!response.ok || !submitted) {
    const detail =
      (data && (data.message || data.reason)) ||
      (data && data.payload && data.payload.payload && (data.payload.payload.detail || data.payload.payload.object)) ||
      text.slice(0, 400) ||
      `HTTP ${response.status}`;
    const err = new Error(
      `Gupshup rejected the send (HTTP ${response.status}) for template ${templateId} -> ${destination}: ${detail}`
    );
    err.response = data || text;
    err.sentParams = params;
    throw err;
  }

  return { messageId: data.messageId || "", raw: data };
}

/**
 * Sends the pending-transaction reminder through Gupshup, with the per-seva
 * link filled into the template's dynamic URL button.
 *
 * Signature matches sendPendingWhatsapp() in whatsapp.service.js so the two
 * providers are interchangeable from the reminder job's point of view.
 */
async function sendPendingWhatsappViaGupshup(phone, donorName, amount, sevaName, options = {}) {
  const { linkSuffix, linkQuery, sourcePage, sevaImage, campaignLabel } = options;

  const fields = buildPendingFields({
    donorName,
    amount,
    sevaName,
    campaignLabel,
    linkSuffix: linkSuffix || sourcePage,
    linkQuery,
    // Gupshup fills the button, so the body sentence stays clean.
    includeLinkInBody: false,
  });

  const params = [fields.name, fields.amount, fields.seva, fields.allocation];
  if (SEND_BUTTON_PARAM()) params.push(fields.suffix);

  const headerImageUrl = await resolveJpegHeaderUrl(sevaImage);

  return sendGupshupTemplate({
    phone,
    templateId: PENDING_TEMPLATE_ID(),
    params,
    headerImageUrl,
  });
}

module.exports = {
  isGupshupConfigured,
  getPendingTemplateId: PENDING_TEMPLATE_ID,
  sendGupshupTemplate,
  sendPendingWhatsappViaGupshup,
  resolveJpegHeaderUrl,
  GUPSHUP_TEMPLATE_URL,
};
