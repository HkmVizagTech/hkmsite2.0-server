// src/services/whatsapp.service.js
//
// Flaxxa WAPI client, wired to the same API contract already used across
// other HkmVizagTech repos (bhajan-clubbing-server, hkm-wapi-crm):
//   Base URL: https://wapi.flaxxa.com
//   Auth: `token` passed INSIDE the JSON body — not a header, not a query
//         param on POST requests.
//   POST /api/v1/sendtemplatemessage  { token, phone, template_name, template_language, components }
//   POST /api/v1/sendmessage          { token, phone, message }  (only works within the
//                                       24h customer-initiated reply window — NOT reliable
//                                       for outbound-first messages like donation receipts)
//
// Phone numbers are stored in the DB in whatever format the donor typed
// (10-digit Indian mobile, usually). Flaxxa expects E.164 without a leading
// "+" — we normalize here rather than trusting the stored format.

const WAPI_BASE = "https://wapi.flaxxa.com";

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
 * @param {string} phone - raw phone number (any common format, normalized here)
 * @param {string} templateName - the exact name of an approved template in
 *   Meta Business Manager (via Flaxxa)
 * @param {Array}  components - Meta template components array, e.g.
 *   [{ type: "body", parameters: [{ type: "text", text: "Ramesh" }, ...] }]
 * @param {string} [language] - defaults to WAPI_TEMPLATE_LANG env var, then "en"
 */
async function sendTemplateMessage(phone, templateName, components, language) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  return callWapi("/api/v1/sendtemplatemessage", {
    phone: normalizedPhone,
    template_name: templateName,
    template_language: language || process.env.WAPI_TEMPLATE_LANG || "en",
    components,
  });
}

/**
 * Sends a free-form text message. Only actually reaches the recipient if
 * they messaged this WhatsApp Business number within the last 24 hours —
 * Meta silently drops outbound-first free text otherwise. Not suitable for
 * donation receipts; kept here for completeness / future inbox-reply use.
 */
async function sendTextMessage(phone, message) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  return callWapi("/api/v1/sendmessage", { phone: normalizedPhone, message });
}

/**
 * Sends an approved WhatsApp template message WITH a file attached (e.g. the
 * receipt PDF) as the template's header media. Flaxxa exposes this as a
 * SEPARATE endpoint from the plain JSON template call above — it requires
 * multipart/form-data (with the token inside the form fields, same as the
 * JSON call) rather than a JSON body, so it can't reuse callWapi().
 *
 * @param {string} phone - raw phone number (normalized here)
 * @param {string} templateName - approved template name whose header is
 *   configured as a document/media placeholder in Meta Business Manager
 * @param {Array}  bodyParameters - just the body{parameters:[...]} array
 *   contents (not the full components wrapper — this function builds that)
 * @param {string} filePath - local path to the PDF to attach
 * @param {string} filename - filename shown to the recipient in WhatsApp
 */
async function sendTemplateMessageWithAttachment(phone, templateName, bodyParameters, filePath, filename, language) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("Invalid or missing phone number");

  const token = process.env.WAPI_TOKEN;
  if (!token) throw new Error("WAPI_TOKEN is not set");

  // Lazy-required: only needed for this one function, and keeps the module
  // loadable even in environments where these packages weren't installed
  // for some reason (the plain JSON path above needs neither).
  const FormData = require("form-data");
  const fs = require("fs");
  const axios = require("axios");

  const form = new FormData();
  form.append("token", token);
  form.append("phone", normalizedPhone);
  form.append("template_name", templateName);
  form.append("template_language", language || process.env.WAPI_TEMPLATE_LANG || "en");
  form.append("components", JSON.stringify([{ type: "body", parameters: bodyParameters }]));
  form.append("header_attachment", fs.createReadStream(filePath), {
    filename,
    contentType: "application/pdf",
  });

  const response = await axios.post(`${WAPI_BASE}/api/v1/sendtemplatemessage_withattachment`, form, {
    headers: form.getHeaders(),
  });
  return response.data;
}

module.exports = {
  isWhatsAppConfigured,
  sendTemplateMessage,
  sendTemplateMessageWithAttachment,
  sendTextMessage,
  normalizePhone,
};
