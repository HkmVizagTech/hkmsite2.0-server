// src/services/receipt.service.js
//
// Fills the shared Hare Krishna donation receipt template (same PDF used by
// the campaigner platform — a fillable AcroForm) with this donation's
// details and flattens it into a final PDF buffer, ready to attach to a
// WhatsApp message or serve as a download.
//
// Uses pdf-lib (not a headless browser) — no Puppeteer, so none of the
// "Target closed" crash class of bugs that hit the Puppeteer-based receipt
// generator on the Subhojanam platform.

const fs = require("fs");
const path = require("path");
const fontkit = require("fontkit");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const numToWord = require("number-to-words");
const { donationModel } = require("../models/donation.model");
const { campaignerModel } = require("../models/campaigner.model");

const resolveFontPath = (fontPath) => {
  if (!fontPath) return null;
  return path.isAbsolute(fontPath) ? fontPath : path.resolve(process.cwd(), fontPath);
};

const DEFAULT_RECEIPT_FONT_PATHS = [
  resolveFontPath(process.env.RECEIPT_FONT_PATH),
  path.resolve(process.cwd(), "assets/fonts/NotoSansTelugu-Regular.ttf"),
].filter(Boolean);

// Strip characters the fallback Helvetica font can't render, rather than
// letting pdf-lib throw on non-Latin text (donor names/addresses sometimes
// include Telugu — the Unicode font above handles that natively; this is
// only the last-resort path if that font file is ever missing).
const sanitizePdfText = (value) => {
  const text = value == null ? "" : String(value);
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
};

const isAsciiOnly = (value) => /^[\x00-\x7F]*$/.test(String(value || ""));

// Only pay the ~15MB Unicode-font-embed cost when this donation's text
// actually contains non-ASCII characters (e.g. a Telugu name/address).
// Most donor input here is plain English even for Telugu speakers, so this
// keeps the common-case receipt small and fast to send over WhatsApp.
const getReceiptFont = async (pdfDoc, fieldValues) => {
  const needsUnicode = fieldValues.some((v) => !isAsciiOnly(v));

  if (!needsUnicode) {
    return { font: await pdfDoc.embedFont(StandardFonts.HelveticaBold), sanitize: false };
  }

  pdfDoc.registerFontkit(fontkit);

  for (const fontPath of DEFAULT_RECEIPT_FONT_PATHS) {
    if (!fs.existsSync(fontPath)) continue;
    try {
      const fontBytes = fs.readFileSync(fontPath);
      // Note: not using {subset:true} here — it hit a font-subsetting bug
      // in this environment (Node 22; Railway runs Node 18, so it may work
      // there, but this is unverified). Matches the exact embedding used in
      // campaign-server's proven, already-in-production receipt generator.
      return { font: await pdfDoc.embedFont(fontBytes), sanitize: false };
    } catch (e) {
      console.warn("receipt.service: failed to embed font", fontPath, e.message);
    }
  }

  console.warn("receipt.service: no Unicode font found, falling back to Helvetica + sanitization");
  return { font: await pdfDoc.embedFont(StandardFonts.HelveticaBold), sanitize: true };
};

const prep = (value, sanitize) => (sanitize ? sanitizePdfText(value) : value == null ? "" : String(value));

const buildAddress = (prasadamAddress) => {
  if (!prasadamAddress) return "---";
  const parts = [
    prasadamAddress.doorNo, prasadamAddress.house, prasadamAddress.street,
    prasadamAddress.area, prasadamAddress.city, prasadamAddress.state,
    prasadamAddress.pincode, prasadamAddress.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "---";
};

/**
 * Generates the receipt PDF for a completed donation. Requires the
 * donation to already have a DCC receiptNumber — callers should check for
 * that before calling this (see paymentCompletion.service.js).
 */
async function generateReceiptBuffer(donationId) {
  const donation = await donationModel.findById(donationId).lean();
  if (!donation) throw new Error("Donation not found for receipt generation");

  const amountWords = `${numToWord.toWords(Math.round(donation.amount)).toUpperCase()} RUPEES ONLY`;
  const formattedDate = new Date(donation.date || donation.createdAt || Date.now()).toLocaleDateString("en-IN");
  const taxExemption = donation.panNumber ? "YES" : "NO";
  const address = buildAddress(donation.prasadamAddress);
  const seva = donation.sevaName || donation.type || "General Seva";

  // "Enrolled by" — best-effort: the campaigner's name if this donation
  // came through a P2P Square Foot Seva link, otherwise blank.
  let enrolledByName = "---";
  if (donation.campaignerSlug) {
    const campaigner = await campaignerModel.findOne({ slug: donation.campaignerSlug }).lean();
    if (campaigner?.name) enrolledByName = campaigner.name;
  }

  const templatePath = path.join(process.cwd(), "receipt-template.pdf");
  const existingPdf = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(existingPdf);

  const nameText = (donation.donorName || "").toUpperCase();
  const receiptText = (donation.receiptNumber || "").split("|").join(" | ");
  const { font, sanitize } = await getReceiptFont(pdfDoc, [
    nameText, address, seva, donation.donorEmail, enrolledByName, receiptText,
  ]);
  const form = pdfDoc.getForm();

  const setField = (name, value) => {
    try {
      form.getTextField(name).setText(prep(value, sanitize));
    } catch (e) {
      // Template may not have every field in every revision — don't fail
      // the whole receipt over one missing field.
      console.warn(`receipt.service: template has no field "${name}", skipping`);
    }
  };

  setField("name", nameText);
  setField("phoneNum", donation.donorMobile || "---");
  setField("inWords", amountWords);
  setField("transactionDate", formattedDate);
  setField("transaction_Date", formattedDate);
  setField("address", address);
  setField("80G", taxExemption);
  setField("towards", seva);
  setField("email", donation.donorEmail || "---");
  setField("enrolledBy", enrolledByName);
  setField("pan", donation.panNumber || "---");
  setField("receiptNumber", receiptText);
  setField("amount", `${Number(donation.amount).toLocaleString("en-IN")}/-`);
  setField("transactionNumber", donation.razorpayPaymentId || donation.transactionId || "---");

  form.getFields().forEach((field) => {
    if (field.updateAppearances) field.updateAppearances(font);
  });
  form.flatten();

  return await pdfDoc.save();
}

module.exports = { generateReceiptBuffer };
