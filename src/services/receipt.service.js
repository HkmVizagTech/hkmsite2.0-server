import fs from "node:fs";
import path from "node:path";
import fontkit from "fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// How a hand-entered donation was paid, as printed after "by" on the receipt.
const MODE_WORDS = { cash: "Cash", cheque: "Cheque", upi: "UPI", bank: "Bank" };
import numToWord from "number-to-words";
import { donations, campaigners, donors } from "../db/tables.js";
import { IST } from "../config/timezone.js";

const resolveFontPath = (fontPath) => {
  if (!fontPath) return null;
  return path.isAbsolute(fontPath) ? fontPath : path.resolve(process.cwd(), fontPath);
};

const DEFAULT_RECEIPT_FONT_PATHS = [
  resolveFontPath(process.env.RECEIPT_FONT_PATH),
  path.resolve(process.cwd(), "assets/fonts/NotoSansTelugu-Regular.ttf"),
].filter(Boolean);

const sanitizePdfText = (value) => {
  const text = value == null ? "" : String(value);
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
};

const isAsciiOnly = (value) => /^[\x00-\x7F]*$/.test(String(value || ""));

const stripAstral = (value) => String(value == null ? "" : value).replace(/[\u{10000}-\u{10FFFF}]/gu, "");

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
    prasadamAddress.doorNo,
    prasadamAddress.house,
    prasadamAddress.street,
    prasadamAddress.area,
    prasadamAddress.city,
    prasadamAddress.state,
    prasadamAddress.pincode,
    prasadamAddress.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "---";
};

async function generateReceiptBuffer(donationId) {
  const donation = await donations.findById(donationId, { lean: true });
  if (!donation) throw new Error("Donation not found for receipt generation");

  const amountWords = `${numToWord.toWords(Math.round(donation.amount)).toUpperCase()} RUPEES ONLY`;
  const formattedDate = new Date(donation.date || donation.createdAt || Date.now()).toLocaleDateString("en-IN", {
    timeZone: IST,
  });
  const taxExemption = donation.panNumber ? "YES" : "NO";
  const address = buildAddress(donation.prasadamAddress);
  const seva = donation.sevaName || donation.type || "General Seva";

  // "Enrolled by" — best-effort: the campaigner's name if this donation
  // came through a P2P Square Foot Seva link, otherwise blank.
  let enrolledByName = "---";
  if (donation.campaignerSlug) {
    const campaigner = await campaigners.findOne({ slug: donation.campaignerSlug }, { sort: { _id: 1 }, lean: true });
    if (campaigner?.name) enrolledByName = campaigner.name;
  }

  let displayDonorId = donation.donorId || "---";
  if (donation.donorRecordId) {
    const donorRecord = await donors.findById(donation.donorRecordId, {
      fields: ["dccDonorNumber", "donorId"],
      lean: true,
    });
    if (donorRecord) displayDonorId = donorRecord.dccDonorNumber || donorRecord.donorId || displayDonorId;
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
    transactionNumber: donation.razorpayPaymentId || donation.utrNumber || donation.transactionId || "---",
    sevakName: donation.sevakName || "---",
    donorId: displayDonorId,
  };

  const needsUnicode = Object.values(fieldValues).some((v) => !isAsciiOnly(stripAstral(v)));

  const templatePath = path.join(process.cwd(), "receipt-template.pdf");
  const existingPdf = fs.readFileSync(templatePath);

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

    if (donation.manualEntry && MODE_WORDS[donation.manualPaymentMode]) {
      try {
        const page = pdfDoc.getPages()[0];
        const h = page.getHeight();
        // "Online" sits at x 51.3-84.5, y 442.2-457.0 from the top (pdftotext
        // -bbox on receipt-template.pdf). Covered with a little margin.
        page.drawRectangle({ x: 50.5, y: h - 457.6, width: 36, height: 16, color: rgb(1, 1, 1) });
        page.drawText(MODE_WORDS[donation.manualPaymentMode], {
          x: 52,
          y: h - 452.8,
          size: 9.5,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
      } catch (err) {
        console.warn(`receipt.service: could not print the payment mode (${err.message})`);
      }
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

export { generateReceiptBuffer };
