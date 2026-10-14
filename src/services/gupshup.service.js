import crypto from "node:crypto";
import { buildPendingFields } from "./pendingMessage.util.js";
import { normalizePhone } from "./whatsapp.service.js";
import sharp from "sharp";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, bucketName } from "../config/R2.config.js";

const GUPSHUP_TEMPLATE_URL = "https://api.gupshup.io/wa/api/v1/template/msg";

// The Gupshup sender is a different WhatsApp number from the Flaxxa one.
const SOURCE_NUMBER = process.env.GUPSHUP_SOURCE_NUMBER || "917075176108";

const PENDING_TEMPLATE_ID = () => process.env.GUPSHUP_PENDING_TEMPLATE_ID || "f12a709c-bc1f-429b-84d5-1262bc01a73c";

const FALLBACK_HEADER_IMAGE =
  process.env.GUPSHUP_FALLBACK_HEADER_IMAGE ||
  "https://fss.gupshup.io/0/public/0/0/gupshup/917075176108/a295be41-efdc-4a25-8e3b-94188f18781e/1787982596334_ChatGPT%20Image%20Aug%2018%2C%202026%2C%2005_47_34%20PM.png";

// Set to "false" if the approved template's button URL turns out to be static
// after all — then no trailing param is appended.
const SEND_BUTTON_PARAM = () => String(process.env.GUPSHUP_PENDING_BUTTON_PARAM || "true") !== "false";

const isGupshupConfigured = () =>
  Boolean(process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_APP_NAME && PENDING_TEMPLATE_ID());

const RECEIPT_TEMPLATE_ID = () => process.env.GUPSHUP_RECEIPT_TEMPLATE_ID || "1c953ac3-3856-4b9d-b4ab-f52f98ba2564";

const isGupshupReceiptConfigured = () =>
  Boolean(process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_APP_NAME && RECEIPT_TEMPLATE_ID());

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

    const jpeg = await sharp(input)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

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
    console.warn(
      "[Gupshup] Could not convert header image to JPEG, falling back to the default banner:",
      err && err.message ? err.message : err
    );
    return FALLBACK_HEADER_IMAGE;
  }
}

// ---------------------------------------------------------------------------

async function sendGupshupTemplate({ phone, templateId, params, headerImageUrl, media }) {
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
  if (media) {
    form.append("message", JSON.stringify(media));
  } else if (headerImageUrl) {
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

async function uploadReceiptPdf(pdfBytes, donationId) {
  const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!publicBase) {
    throw new Error(
      "R2_PUBLIC_URL is not set — Gupshup can only attach a receipt from a public link, " +
        "so the PDF cannot be delivered. Set R2_PUBLIC_URL (and the R2_* credentials) in Railway."
    );
  }

  const salt = process.env.RECEIPT_URL_SALT || "hkmv-receipt";
  const hash = crypto.createHash("sha256").update(`${salt}:${donationId}`).digest("hex").slice(0, 24);
  const key = `receipts/${hash}.pdf`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: Buffer.from(pdfBytes),
      ContentType: "application/pdf",
      // Short cache: a resend after a corrected receipt must not serve the
      // stale PDF to Meta from an edge cache.
      CacheControl: "public, max-age=300",
    })
  );

  return `${publicBase}/${key}`;
}

async function sendReceiptWhatsappViaGupshup({
  phone,
  donorName,
  amountText,
  sevaName,
  pdfBytes,
  filename,
  donationId,
}) {
  const link = await uploadReceiptPdf(pdfBytes, donationId);

  return sendGupshupTemplate({
    phone,
    templateId: RECEIPT_TEMPLATE_ID(),
    params: [donorName, amountText, sevaName],
    media: {
      type: "document",
      document: { link, filename: filename || "Donation_Receipt.pdf" },
    },
  });
}

export {
  isGupshupConfigured,
  isGupshupReceiptConfigured,
  PENDING_TEMPLATE_ID as getPendingTemplateId,
  RECEIPT_TEMPLATE_ID as getReceiptTemplateId,
  sendGupshupTemplate,
  sendPendingWhatsappViaGupshup,
  sendReceiptWhatsappViaGupshup,
  uploadReceiptPdf,
  resolveJpegHeaderUrl,
  GUPSHUP_TEMPLATE_URL,
  FALLBACK_HEADER_IMAGE,
};
