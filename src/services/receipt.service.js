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

// Characters outside the Basic Multilingual Plane — emoji, pictographs. No
// receipt font has glyphs for these (donors do paste 🙏 into name fields), and
// they would draw as empty boxes, so they come out everywhere.
const stripAstral = (value) => String(value == null ? "" : value).replace(/[\u{10000}-\u{10FFFF}]/gu, "");

// Does the installed fontkit support the subsetting pdf-lib asks for?
//
// This matters a lot for receipt size: the bundled Unicode font is ~23MB, so a
// full embed yields a ~16MB receipt (slow to upload to R2, slow for Meta to
// fetch, unpleasant for the donor to download) while a subset embed yields
// ~0.4MB — a 40x difference on every non-Latin receipt.
//
// pdf-lib calls `subset.encodeStream()`, which fontkit v1 has and v2 removed.
// It CANNOT be detected with a try/catch around embedFont(): pdf-lib defers
// the actual embedding to save() time, so the failure surfaces at the very end
// and takes the whole receipt with it. Hence this upfront probe, cached for
// the process lifetime.
//
// => Pin fontkit to ^1.9.0 in package.json to get the small receipts.
let subsetSupport = null;
const supportsSubsetting = (fontBytes) => {
  if (subsetSupport !== null) return subsetSupport;
  try {
    const probe = fontkit.create(fontBytes);
    subsetSupport = typeof probe.createSubset().encodeStream === "function";
  } catch (e) {
    subsetSupport = false;
  }
  if (!subsetSupport) {
    console.warn(
      "receipt.service: this fontkit version cannot subset fonts (pdf-lib needs fontkit ^1), so receipts containing non-Latin text will be ~16MB instead of ~0.4MB. Pin fontkit to ^1.9.0 to fix."
    );
  }
  return subsetSupport;
};

/**
 * Embeds the Unicode font, subsetting it when that is actually supported.
 * Returns null if no usable font file is present, in which case the caller
 * falls back to Helvetica with ASCII sanitization.
 */
const embedUnicodeFont = async (pdfDoc, { allowSubset = true } = {}) => {
  pdfDoc.registerFontkit(fontkit);

  for (const fontPath of DEFAULT_RECEIPT_FONT_PATHS) {
    if (!fs.existsSync(fontPath)) continue;
    const fontBytes = fs.readFileSync(fontPath);
    const subset = allowSubset && supportsSubsetting(fontBytes);

    try {
      return await pdfDoc.embedFont(fontBytes, subset ? { subset: true } : undefined);
    } catch (e) {
      console.warn("receipt.service: failed to embed font", fontPath, e.message);
    }
  }

  return null;
};

const prep = (value, sanitize) => (sanitize ? sanitizePdfText(value) : stripAstral(value));

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

  const nameText = (donation.donorName || "").toUpperCase();
  const receiptText = (donation.receiptNumber || "").split("|").join(" | ");

  // Every value that goes on the receipt, keyed by its template field.
  const fieldValues = {
    name: nameText,
    phoneNum: donation.donorMobile || "---",
    inWords: amountWords,
    transactionDate: formattedDate,
    transaction_Date: formattedDate,
    address,
    "80G": taxExemption,
    towards: seva,
    email: donation.donorEmail || "---",
    enrolledBy: enrolledByName,
    pan: donation.panNumber || "---",
    receiptNumber: receiptText,
    amount: `${Number(donation.amount).toLocaleString("en-IN")}/-`,
    transactionNumber: donation.razorpayPaymentId || donation.transactionId || "---",
    sevakName: donation.sevakName || "---",
  };

  // ALL values decide whether the Unicode font is needed — not a hand-picked
  // few. An earlier version checked only six of these, so non-Latin text in
  // any other field (sevakName above all, which is very often a Telugu name)
  // left the WinAnsi-only Helvetica selected, and updateAppearances below then
  // threw `WinAnsi cannot encode "స" (0x0c38)`. That killed the whole receipt,
  // which in turn meant no WhatsApp receipt for that donor at all.
  // Checked AFTER stripping emoji, since those are removed rather than drawn:
  // a donor who typed "Devotee 🙏" in an otherwise Latin form shouldn't cost
  // this receipt a 23MB font embed.
  const needsUnicode = Object.values(fieldValues).some((v) => !isAsciiOnly(stripAstral(v)));

  const templatePath = path.join(process.cwd(), "receipt-template.pdf");
  const existingPdf = fs.readFileSync(templatePath);

  // The whole document is built inside this function so it can be retried
  // from scratch: pdf-lib embeds fonts lazily at save() time, so a font
  // problem only shows up at the very end, and a PDFDocument can't be
  // re-saved after a failed save. One clean retry without subsetting turns
  // "no receipt at all" into "a slightly larger receipt".
  const render = async ({ allowSubset }) => {
  const pdfDoc = await PDFDocument.load(existingPdf);

  // Always available, both as the all-ASCII default and as the per-field
  // rescue font in the safety net below.
  const helvetica = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let font = helvetica;

  if (needsUnicode) {
    const unicodeFont = await embedUnicodeFont(pdfDoc, { allowSubset });
    if (unicodeFont) font = unicodeFont;
    else console.warn("receipt.service: no Unicode font available, falling back to Helvetica + sanitization");
  }

  // Sanitizing is only needed when non-Latin text has to be drawn in a
  // WinAnsi font; with the Unicode font the real characters are kept.
  const sanitize = font === helvetica;
  const form = pdfDoc.getForm();

  for (const [name, value] of Object.entries(fieldValues)) {
    try {
      form.getTextField(name).setText(prep(value, sanitize));
    } catch (e) {
      // Template may not have every field in every revision — don't fail
      // the whole receipt over one missing field.
      console.warn(`receipt.service: template has no field "${name}", skipping`);
    }
  }

  // Safety net: one unencodable character must never cost a donor their whole
  // receipt. Appearances are generated per field, so a field that refuses to
  // draw is retried as ASCII in the built-in font, and blanked only if even
  // that fails. Better a receipt with one mangled line than none.
  for (const field of form.getFields()) {
    if (!field.updateAppearances) continue;
    const name = field.getName();
    try {
      field.updateAppearances(font);
    } catch (err) {
      console.warn(`receipt.service: field "${name}" could not be drawn (${err.message}) — retrying it as ASCII`);
      try {
        if (name in fieldValues) form.getTextField(name).setText(sanitizePdfText(fieldValues[name]));
        field.updateAppearances(helvetica);
      } catch (retryErr) {
        console.warn(`receipt.service: field "${name}" still failed (${retryErr.message}) — leaving it blank`);
        try {
          form.getTextField(name).setText("");
          field.updateAppearances(helvetica);
        } catch {}
      }
    }
  }

  try {
    form.flatten();
  } catch (err) {
    // Flattening is cosmetic (it makes the fields non-editable). A receipt
    // with live form fields is still a correct, complete receipt.
    console.warn(`receipt.service: could not flatten the form (${err.message}) — saving with fields intact`);
  }

  return await pdfDoc.save();
  };

  try {
    return await render({ allowSubset: true });
  } catch (err) {
    if (!needsUnicode) throw err;
    console.warn(
      `receipt.service: receipt render failed (${err && err.message ? err.message : err}) — retrying once with the full (unsubsetted) font`
    );
    return await render({ allowSubset: false });
  }
}

module.exports = { generateReceiptBuffer };
