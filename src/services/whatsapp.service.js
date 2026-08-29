// src/services/whatsapp.service.js
//
// Flaxxa WAPI client.
//   Base URL: https://wapi.flaxxa.com
//   Auth: `token` passed INSIDE the JSON body / form fields — not a header.
//   POST /api/v1/sendtemplatemessage                 { token, phone, template_name, template_language, components }
//   POST /api/v1/sendtemplatemessage_withattachment  multipart, same fields + header_attachment
//   POST /api/v1/sendmessage                         { token, phone, message }  (24h window only)
//
// ---------------------------------------------------------------------------
// HARD-WON FACTS ABOUT THIS API — verified against the live endpoint
// (Aug 2026, token 9234…, test recipient 919951141915). Do not "simplify"
// any of this away; every line below is the result of a failing send.
//
// 1. FAILURE LOOKS LIKE SUCCESS.
//    Flaxxa answers HTTP 200 {"status":"success","message_wamid":null} when
//    Meta REJECTED the message. Only a non-null message_wamid means it was
//    actually delivered to WhatsApp. assertDelivered() turns the null case
//    into a thrown error — without it, callers mark records as "sent" for
//    messages that never left. This is why the pending reminder appeared to
//    work while nothing arrived.
//
// 2. FLAXXA DOES NOT SUPPORT DYNAMIC URL BUTTONS.
//    A template whose button URL ends in {{1}} can NEVER be sent through this
//    API. Meta replies "(#131008) Required parameter is missing" because
//    Flaxxa drops the button parameter on the way through. Verified against
//    every shape: components [{type:"button",sub_type:"url",index:"0"|0,...}]
//    (before and after the body component), sub_type "URL", parameter type
//    "payload", and top-level button / buttons / button_1 / button_url /
//    button_text_1 / button_url_1 / dynamic_url / button_value / button_parameters.
//    All of them return message_wamid: null. A known-good template on the same
//    account WITHOUT a dynamic button sends fine in the same run.
//    => Template button URLs must be STATIC. Per-page links go in the body.
//
// 3. HEADER IMAGES CANNOT BE SENT AS A LINK.
//    {type:"header", parameters:[{type:"image", image:{link}}]} on the JSON
//    endpoint is ignored — Meta then reports the header parameter missing.
//    Header media must be POSTed as binary on the _withattachment endpoint.
//    (Confirmed working: bc_qr_pass_v4 + binary header_attachment.)
//
// 4. THE MULTIPART FIELD IS "components", NOT "components[]".
//    "components[]" makes Flaxxa throw
//    json_decode(): Argument #1 ($json) must be of type string, array given.
//
// 5. META ACCEPTS ONLY image/jpeg AND image/png FOR IMAGE HEADERS.
//    The seva banners in R2 are .webp, so they are converted with sharp
//    before being attached.
// ---------------------------------------------------------------------------

const WAPI_BASE = "https://wapi.flaxxa.com";

const { buildPendingFields } = require("./pendingMessage.util");

const isWhatsAppConfigured = () => Boolean(process.env.WAPI_TOKEN);

// Normalizes an Indian mobile number to E.164 without "+": strips
// non-digits, and adds the "91" country code only if it looks like a bare
// 10-digit number (avoids double-prefixing numbers already stored with 91).
const normalizePhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits; // already looks international, or too malformed to fix — pass through
};

/**
 * Flaxxa returns HTTP 200 for messages Meta refused. The only reliable
 * success signal is a non-null message_wamid. Throwing here is what lets
 * callers (pending reminders, receipts) record a real failure instead of
 * silently flagging the record as sent.
 */
function assertDelivered(payload, context) {
  const wamid = payload && (payload.message_wamid || payload.wamid);
  if (wamid) return payload;

  const status = payload && payload.status;
  const detail =
    (payload && (payload.error || payload.message)) ||
    "Meta rejected the send (message_wamid was null)";

  const err = new Error(
    `WhatsApp send failed for ${context}: ${detail}` +
      (status ? ` [flaxxa status: ${status}]` : "") +
      ". Common causes: the template has a dynamic {{1}} URL button (unsupported by Flaxxa)," +
      " a required header parameter was not supplied, or the template/language pair is wrong."
  );
  err.response = payload;
  throw err;
}

async function callWapi(path, body) {
  const token = process.env.WAPI_TOKEN;
  if (!token) throw new Error("WAPI_TOKEN is not set");

  const res = await fetch(`${WAPI_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });

  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  if (!res.ok) {
    const message = (parsed && parsed.message) || raw || `WAPI request failed with status ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.response = parsed;
    throw err;
  }

  return parsed;
}

/**
 * Sends an approved WhatsApp template message (works even for the very
 * first message to a donor — required for outbound receipts/confirmations,
 * unlike free-form sendMessage which only works inside a 24h reply window).
 *
 * NOTE: do not pass a {type:"button"} component — Flaxxa discards it (see
 * fact 2 at the top of this file). Keep template button URLs static.
 *
 * @param {string} phone - raw phone number (any common format, normalized here)
 * @param {string} templateName - exact name of an approved template
 * @param {Array}  components - Meta template components array, e.g.
 *   [{ type: "body", parameters: [{ type: "text", text: "Ramesh" }, ...] }]
 * @param {string} [language] - defaults to WAPI_TEMPLATE_LANG env var, then "en"
 */
async function sendTemplateMessage(phone, templateName, components, language) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const result = await callWapi("/api/v1/sendtemplatemessage", {
    phone: normalizedPhone,
    template_name: templateName,
    template_language: language || process.env.WAPI_TEMPLATE_LANG || "en",
    components,
  });

  return assertDelivered(result, `template "${templateName}" -> ${normalizedPhone}`);
}

/**
 * Sends a free-form text message. Only actually reaches the recipient if
 * they messaged this WhatsApp Business number within the last 24 hours.
 */
async function sendTextMessage(phone, message) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const result = await callWapi("/api/v1/sendmessage", { phone: normalizedPhone, message });
  return assertDelivered(result, `text message -> ${normalizedPhone}`);
}

/**
 * Low-level multipart template send. Header media (PDF or image) goes up as
 * binary in `header_attachment`; this is the ONLY way header media reaches
 * Meta through Flaxxa.
 *
 * @param {string} normalizedPhone - already normalized E.164-without-plus
 * @param {string} templateName
 * @param {Array}  components - full components array (body only; no buttons)
 * @param {Buffer|import("stream").Readable} file
 * @param {string} filename
 * @param {string} contentType - "application/pdf" | "image/jpeg" | "image/png"
 * @param {string} [language]
 */
async function postTemplateWithAttachment(normalizedPhone, templateName, components, file, filename, contentType, language) {
  const token = process.env.WAPI_TOKEN;
  if (!token) throw new Error("WAPI_TOKEN is not set");

  const FormData = require("form-data");
  const axios = require("axios");

  const form = new FormData();
  form.append("token", token);
  form.append("phone", normalizedPhone);
  form.append("template_name", templateName);
  form.append("template_language", language || process.env.WAPI_TEMPLATE_LANG || "en");
  // MUST be "components" — "components[]" makes Flaxxa throw (fact 4 above).
  form.append("components", JSON.stringify(components));
  form.append("header_attachment", file, { filename, contentType });

  const response = await axios.post(`${WAPI_BASE}/api/v1/sendtemplatemessage_withattachment`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return assertDelivered(response.data, `template "${templateName}" (+${contentType}) -> ${normalizedPhone}`);
}

/**
 * Sends an approved template WITH a PDF attached as the template's header
 * media (e.g. the donation receipt).
 *
 * @param {Array} bodyParameters - just the body parameters array (not the
 *   full components wrapper — this function builds that)
 */
async function sendTemplateMessageWithAttachment(phone, templateName, bodyParameters, filePath, filename, language) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const fs = require("fs");
  return postTemplateWithAttachment(
    normalizedPhone,
    templateName,
    [{ type: "body", parameters: bodyParameters }],
    fs.createReadStream(filePath),
    filename,
    "application/pdf",
    language
  );
}

// ---------------------------------------------------------------------------
// Header image handling
//
// Meta accepts only image/jpeg and image/png for image headers, and Flaxxa
// will not fetch a header image from a link — so the banner is downloaded
// here, converted to JPEG, and attached as binary. Converted buffers are
// cached per URL for the process lifetime: the same handful of seva banners
// are reused across every reminder run.
// ---------------------------------------------------------------------------

const headerImageCache = new Map();
const MAX_HEADER_BYTES = 4.5 * 1024 * 1024; // Meta's limit is 5MB

async function fetchHeaderImageJpeg(url) {
  if (!url) return null;
  if (headerImageCache.has(url)) return headerImageCache.get(url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Header image download failed (HTTP ${res.status}): ${url}`);
  const input = Buffer.from(await res.arrayBuffer());

  const sharp = require("sharp");
  let jpeg = await sharp(input)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();

  if (jpeg.length > MAX_HEADER_BYTES) {
    jpeg = await sharp(input)
      .rotate()
      .resize({ width: 1080, withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();
  }

  headerImageCache.set(url, jpeg);
  return jpeg;
}

// ---------------------------------------------------------------------------
// Pending-transaction ("donation recorded, payment not yet confirmed") reminder.
//
// Template shape this code expects (pending_seva_notice):
//   header : IMAGE  — supplied per seva as a binary JPEG attachment
//   body   : 4 variables
//              {{1}} donor name
//              {{2}} amount
//              {{3}} seva name
//              {{4}} allocation sentence, WITH the seva's page link appended
//   button : optional, and its URL MUST BE STATIC (no {{1}}). Flaxxa cannot
//            supply a button variable, so a dynamic button URL makes every
//            send fail with (#131008). The per-seva link lives in {{4}} instead.
// ---------------------------------------------------------------------------

const PENDING_TEMPLATE_NAME =
  process.env.WAPI_PENDING_TEMPLATE_NAME || "pending_seva_notice";

/**
 * Sends the approved "pending transaction" WhatsApp template to a donor
 * whose donation was recorded but whose payment is not yet confirmed.
 *
 * @param {string} phone - raw donor mobile (normalized here)
 * @param {string} donorName - {{1}}
 * @param {number|string} amount - {{2}}
 * @param {string} [sevaName] - {{3}}, also embedded in {{4}}
 * @param {object} [options]
 * @param {string} [options.linkSuffix] - seva page path, e.g. "brick-seva-campaign"
 * @param {string} [options.sourcePage] - fallback for linkSuffix
 * @param {string} [options.sevaImage] - header banner URL for this seva
 */
async function sendPendingWhatsapp(phone, donorName, amount, sevaName, options = {}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const { linkSuffix, sourcePage, sevaImage } = options;

  // includeLinkInBody: true — on Flaxxa the template's button URL must be
  // static (fact 2 above), so the seva link rides along in {{4}} instead.
  const fields = buildPendingFields({
    donorName,
    amount,
    sevaName,
    linkSuffix: linkSuffix || sourcePage,
    includeLinkInBody: true,
  });

  const components = [
    {
      type: "body",
      parameters: [
        { type: "text", text: fields.name },
        { type: "text", text: fields.amount },
        { type: "text", text: fields.seva },
        { type: "text", text: fields.allocation },
      ],
    },
  ];

  // Image header -> must go up as binary. If no banner resolves, fall back to
  // the plain JSON send (only valid if the template has no media header).
  if (sevaImage) {
    const jpeg = await fetchHeaderImageJpeg(sevaImage);
    return postTemplateWithAttachment(
      normalizedPhone,
      PENDING_TEMPLATE_NAME,
      components,
      jpeg,
      "seva-banner.jpg",
      "image/jpeg"
    );
  }

  return sendTemplateMessage(normalizedPhone, PENDING_TEMPLATE_NAME, components);
}

module.exports = {
  isWhatsAppConfigured,
  sendTemplateMessage,
  sendTemplateMessageWithAttachment,
  sendTextMessage,
  sendPendingWhatsapp,
  normalizePhone,
  fetchHeaderImageJpeg,
};
