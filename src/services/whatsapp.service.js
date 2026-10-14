const WAPI_BASE = "https://wapi.flaxxa.com";

import { buildPendingFields } from "./pendingMessage.util.js";
import FormData from "form-data";
import axios from "axios";
import fs from "node:fs";
import sharp from "sharp";

const isWhatsAppConfigured = () => Boolean(process.env.WAPI_TOKEN);

const normalizePhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits; // already looks international, or too malformed to fix — pass through
};

function assertDelivered(payload, context) {
  const wamid = payload && (payload.message_wamid || payload.wamid);
  if (wamid) return payload;

  const status = payload && payload.status;
  const rawBody = JSON.stringify(payload);
  const detail =
    (payload && (payload.error || payload.message || payload.errors)) ||
    "Meta rejected the send (message_wamid was null)";

  const err = new Error(
    `WhatsApp send failed for ${context}: ${detail}` +
      (status ? ` [flaxxa status: ${status}]` : "") +
      ". Common causes: the template has a dynamic {{1}} URL button (unsupported by Flaxxa)," +
      " a required header parameter was not supplied, or the template/language pair is wrong." +
      ` RAW: ${rawBody}`
  );
  err.response = payload;
  throw err;
}

const WAPI_TIMEOUT_MS = Number(process.env.WAPI_TIMEOUT_MS || 15000);

async function callWapi(path, body) {
  const token = process.env.WAPI_TOKEN;
  if (!token) throw new Error("WAPI_TOKEN is not set");

  let res;
  try {
    res = await fetch(`${WAPI_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...body }),
      signal: AbortSignal.timeout(WAPI_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err && err.name === "TimeoutError" ? `timed out after ${WAPI_TIMEOUT_MS}ms` : (err && err.message) || String(err);
    const wrapped = new Error(`WhatsApp provider unreachable (${WAPI_BASE}): ${reason}`);
    wrapped.cause = err;
    wrapped.providerUnreachable = true;
    throw wrapped;
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  if (!res.ok) {
    const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(raw);
    const message = looksLikeHtml
      ? `WhatsApp provider returned an HTTP ${res.status} error page (provider outage, not a rejected message)`
      : (parsed && parsed.message) || (raw ? raw.slice(0, 300) : "") || `WAPI request failed with status ${res.status}`;

    const err = new Error(message);
    err.status = res.status;
    err.response = looksLikeHtml ? { status: res.status, html: true } : parsed;
    // 5xx and Cloudflare's 52x are the provider failing, not Meta rejecting
    // this particular message — callers word those differently.
    if (looksLikeHtml || res.status >= 500) err.providerUnreachable = true;
    throw err;
  }

  return parsed;
}

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

async function sendTextMessage(phone, message) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const result = await callWapi("/api/v1/sendmessage", { phone: normalizedPhone, message });
  return assertDelivered(result, `text message -> ${normalizedPhone}`);
}

async function postTemplateWithAttachment(
  normalizedPhone,
  templateName,
  components,
  file,
  filename,
  contentType,
  language
) {
  const token = process.env.WAPI_TOKEN;
  if (!token) throw new Error("WAPI_TOKEN is not set");

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
    timeout: Number(process.env.WAPI_UPLOAD_TIMEOUT_MS || 45000),
  });

  return assertDelivered(response.data, `template "${templateName}" (+${contentType}) -> ${normalizedPhone}`);
}

async function sendTemplateMessageWithAttachment(phone, templateName, bodyParameters, filePath, filename, language) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

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

const headerImageCache = new Map();
const MAX_HEADER_BYTES = 4.5 * 1024 * 1024; // Meta's limit is 5MB

async function fetchHeaderImageJpeg(url) {
  if (!url) return null;
  if (headerImageCache.has(url)) return headerImageCache.get(url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Header image download failed (HTTP ${res.status}): ${url}`);
  const input = Buffer.from(await res.arrayBuffer());

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

const PENDING_TEMPLATE_NAME = process.env.WAPI_PENDING_TEMPLATE_NAME || "pending_seva_notice";

async function sendPendingWhatsapp(phone, donorName, amount, sevaName, options = {}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const { linkSuffix, linkQuery, sourcePage, sevaImage, campaignLabel } = options;

  // includeLinkInBody: true — on Flaxxa the template's button URL must be
  // static (fact 2 above), so the seva link rides along in {{4}} instead.
  const fields = buildPendingFields({
    donorName,
    amount,
    sevaName,
    campaignLabel,
    linkSuffix: linkSuffix || sourcePage,
    linkQuery,
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

const UTILITY_TEMPLATE_NAME = process.env.WAPI_UTILITY_TEMPLATE_NAME || "hkm_utility_notification";

async function sendUtilityMessage(phone, messageText) {
  const components = [{ type: "body", parameters: [{ type: "text", text: String(messageText) }] }];
  return sendTemplateMessage(phone, UTILITY_TEMPLATE_NAME, components);
}

async function sendDonorOtp(phone, otpCode) {
  const OTP_TEMPLATE_NAME = process.env.WAPI_OTP_TEMPLATE_NAME || "otp";
  const components = [
    { type: "body", parameters: [{ type: "text", text: String(otpCode) }] },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(otpCode) }],
    },
  ];
  return sendTemplateMessage(phone, OTP_TEMPLATE_NAME, components, "en");
}

export {
  isWhatsAppConfigured,
  sendTemplateMessage,
  sendTemplateMessageWithAttachment,
  sendTextMessage,
  sendPendingWhatsapp,
  sendDonorOtp,
  sendUtilityMessage,
  normalizePhone,
  fetchHeaderImageJpeg,
};
