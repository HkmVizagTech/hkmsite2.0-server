// scripts/build-tsc-receipt-template.js
//
// Builds receipt-template-tsc.pdf: the Touchstone Charities (TSC) twin of the
// HKMI receipt-template.pdf. receipt.service.js fills it instead of the HKMI
// one when a donation was raised under DCC account type 5.
//
// The text content mirrors what DCC's own PDFService prints for account type
// TSC (header, PAN, stamp, "for Touchstone Charities, Visakhapatnam", no
// head-office line). The form fields are copied from receipt-template.pdf --
// same names, same rectangles, same font sizes -- so receipt.service.js fills
// both templates with one code path. One extra field, `paymentMode`, holds the
// word after "by": the HKMI template prints "Online" as fixed text and covers
// it for hand-entered donations, which a TSC receipt does not need to do.
//
// Run from the server root:  node scripts/build-tsc-receipt-template.cjs
// Re-run only if the HKMI template's field layout changes.

const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb, PDFName } = require("pdf-lib");

const ROOT = process.cwd();
const HKMI_TEMPLATE = path.join(ROOT, "receipt-template.pdf");
const OUT = path.join(ROOT, "receipt-template-tsc.pdf");
const LOGO = path.join(ROOT, "assets/receipt/tsclogo.JPG");
const STAMP = path.join(ROOT, "assets/receipt/tcvstamp.png");

const RIGHT = 500; // right edge of the header / footer text block
const BLACK = rgb(0, 0, 0);

async function build() {
  const src = await PDFDocument.load(fs.readFileSync(HKMI_TEMPLATE));
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.92, 841.92]);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const sansBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const text = (s, x, y, size, font = serif, color = BLACK) =>
    page.drawText(s, { x, y, size, font, color });
  const textRight = (s, xRight, y, size, font = serif) =>
    text(s, xRight - font.widthOfTextAtSize(s, size), y, size, font);
  const textCenter = (s, xCenter, y, size, font = serif) =>
    text(s, xCenter - font.widthOfTextAtSize(s, size) / 2, y, size, font);

  // ---- status banner (same grey acknowledgement banner as the HKMI template) ----
  const grey = rgb(0.66, 0.66, 0.66);
  for (const [s, y] of [["DONATION", 756], ["ACKNOWLEDGEMENT", 738]]) {
    text(s, RIGHT - sansBold.widthOfTextAtSize(s, 16), y, 16, sansBold, grey);
  }

  // ---- header: logo + organisation block ----
  const logo = await doc.embedJpg(fs.readFileSync(LOGO));
  const logoH = 61;
  page.drawImage(logo, { x: 37, y: 632, width: (logo.width / logo.height) * logoH, height: logoH });

  textRight("TOUCHSTONE CHARITIES VISAKHAPATNAM", RIGHT, 674, 15.5, serifBold);
  const header = [
    "(Serving the Mission of His Divine Grace A.C. Bhaktivendanta swami Prabhupada)",
    "Regd. Off : #8-22, Near RTO Office, Next to Akshaya Patra Foundation Kitchen,",
    "IIM Road, Gambheeram, Visakhapatanam - 530052. (A.P.) INDIA.",
    "Phone : +91 9030696108, E-mail : donorcare@hkmvizag.org",
    "TSC PAN No : AACTT5014B",
  ];
  header.forEach((line, i) => textRight(line, RIGHT, 659 - i * 12.7, 8));

  // ---- title row ----
  text("DONATION RECEIPT", 121, 572, 12.5, serifBold);
  page.drawLine({ start: { x: 121, y: 570 }, end: { x: 259, y: 570 }, thickness: 0.7, color: BLACK });
  text("DR No.", 343.5, 569, 9.5);
  text("Date:", 424, 556, 9.5);

  // ---- labels (baselines sit just above each field's rectangle) ----
  const L = 38;
  const LABEL = 9.5;
  text("Name of the Donor :", L, 527, LABEL);
  text("Address :", L, 506, LABEL);
  text("Reference(Patronship No) :", L, 486, LABEL);
  text("Sevak Name :", 297, 486, LABEL);
  text("Phone : Res :", L, 467, LABEL);
  text("Off :", 116, 467, LABEL);
  text("Mobile :", 297, 467, LABEL);
  text("Tax exemption Required", L, 447, LABEL);
  text("(Under section 80G, of the Income Tax Act)", 173, 447, LABEL);
  text("E-mail :", L, 428, LABEL);
  text("PAN :", 350, 428, LABEL);
  text("Rs.", L, 410, LABEL);
  text("Rupees :", 151, 410, LABEL);
  text("by", L, 389, LABEL);
  text("Reference No :", 107, 389, LABEL);
  text("Date :", 346, 389, LABEL);
  text("Bank :", L, 371, LABEL);
  text("Enrolled by", 89, 371, LABEL);
  text("Towards :", 297, 371, LABEL);
  text("*Cheque Payment : Subject to realization. We do not accept anonymous donations.", L, 350, 8);

  // ---- footer: stamp, "for ...", mantra, e-receipt note ----
  const stamp = await doc.embedPng(fs.readFileSync(STAMP));
  page.drawImage(stamp, { x: 435, y: 246, width: 58, height: 58 });
  const forY = 231;
  const orgName = "Touchstone Charities, Visakhapatnam";
  const orgW = serifBold.widthOfTextAtSize(orgName, 9);
  text(orgName, RIGHT - orgW, forY, 9, serifBold);
  text("for", RIGHT - orgW - serif.widthOfTextAtSize("for ", 9), forY, 9);
  textCenter(
    "Hare Krishna Hare Krishna Krishna Krishna Hare Hare  Hare Rama Hare Rama Rama Rama Hare Hare",
    268, 188, 8.2
  );
  textCenter("*This is an electronically generated receipt, hence does not require signature", 268, 152, 8.2);

  // ---- form fields: copied from the HKMI template ----
  const form = doc.getForm();
  const helv = await doc.embedFont(StandardFonts.HelveticaBold);
  const FIXED_SIZE = { sevakName: 9, donorId: 6.5, pan: 0, phoneNum: 0 };
  for (const f of src.getForm().getFields()) {
    const name = f.getName();
    const r = f.acroField.getWidgets()[0].getRectangle();
    const tf = form.createTextField(name);
    tf.addToPage(page, {
      x: r.x, y: r.y, width: r.width, height: r.height,
      font: helv, borderWidth: 0, textColor: BLACK,
    });
    tf.setFontSize(name in FIXED_SIZE ? FIXED_SIZE[name] : 8.604);
  }
  // The word after "by" (Online / Cash / Cheque / UPI / Bank).
  const mode = form.createTextField("paymentMode");
  mode.addToPage(page, { x: 52, y: 387, width: 50, height: 12, font: helv, borderWidth: 0, textColor: BLACK });
  mode.setFontSize(8.604);

  fs.writeFileSync(OUT, await doc.save());
  console.log("wrote", OUT);
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
