// Adds a fillable AcroForm text field "sevakName" to receipt-template.pdf
// next to the existing "Sevak Name :" printed label, then saves the result.
// Run once: node scripts/add-sevakname-field.js

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, rgb } from "pdf-lib";
import fs from "node:fs";
import path from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATE = path.join(__dirname, "../receipt-template.pdf");
const BACKUP = path.join(__dirname, "../receipt-template.backup.pdf");

(async () => {
  // Always restore from backup so we start clean
  const bytes = fs.readFileSync(BACKUP);

  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const page = doc.getPages()[0];

  // Position calibrated from existing fields:
  //   address y=503, phoneNum y=464 → "Sevak Name :" row sits at ~y=483
  //   Shifted left to x=370 to close the gap after the printed label
  const field = form.createTextField("sevakName");
  field.addToPage(page, {
    x: 370,
    y: 483,
    width: 195,
    height: 12,
    borderWidth: 0,
    borderColor: rgb(1, 1, 1), // white — fully invisible
    backgroundColor: rgb(1, 1, 1), // white background, no black box
  });

  const widget = field.acroField.getWidgets()[0];
  widget.setDefaultAppearance("/Helv 9 Tf 0 g");

  const updated = await doc.save();
  fs.writeFileSync(TEMPLATE, updated);
  console.log("✅ sevakName field added to", TEMPLATE);

  // Verify
  const verify = await PDFDocument.load(updated);
  const names = verify
    .getForm()
    .getFields()
    .map((f) => f.getName());
  console.log("Fields now in template:", names.join(", "));
})();
