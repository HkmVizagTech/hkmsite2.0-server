// Verifies the pending-transaction template on GUPSHUP (sender 917075176108).
//
//   node test-pending-gupshup.js --dry            # print the exact payload, send nothing
//   node test-pending-gupshup.js 919876543210     # real send
//
// Requires in .env:
//   GUPSHUP_API_KEY               account API key (Gupshup console -> your app)
//   GUPSHUP_APP_NAME              the app name, sent as src.name
//   GUPSHUP_PENDING_TEMPLATE_ID   the approved template's UUID
//   GUPSHUP_SOURCE_NUMBER         optional, defaults to 917075176108
//
// If the send is rejected, the error prints Gupshup's own reason plus the
// params array that was sent — the usual cause is a param-count mismatch:
// 4 body variables + 1 trailing value for the button URL = 5 entries. If the
// approved template's button URL ended up static, set
// GUPSHUP_PENDING_BUTTON_PARAM=false and the 5th entry is dropped.

require("dotenv").config();

const { buildPendingFields } = require("./src/services/pendingMessage.util");
const {
  isGupshupConfigured,
  sendPendingWhatsappViaGupshup,
  resolveJpegHeaderUrl,
  getPendingTemplateId,
} = require("./src/services/gupshup.service");

const BANNER =
  process.env.WAPI_PENDING_IMAGE ||
  "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1785588189215-1785588187426-brick-hero-desk.webp";

const SAMPLE = {
  donorName: "Test Devotee",
  amount: 100,
  sevaName: "Brick Seva",
  linkSuffix: "brick-seva-campaign",
};

async function main() {
  const arg = process.argv[2];
  const dry = arg === "--dry" || arg === "-n";
  const phone = dry ? "919999999999" : arg;

  if (!phone) {
    console.error("Usage: node test-pending-gupshup.js <phone>   (or --dry)");
    process.exit(1);
  }

  const fields = buildPendingFields({ ...SAMPLE, includeLinkInBody: false });
  const sendButtonParam = String(process.env.GUPSHUP_PENDING_BUTTON_PARAM || "true") !== "false";
  const params = [fields.name, fields.amount, fields.seva, fields.allocation];
  if (sendButtonParam) params.push(fields.suffix);

  console.log("source      :", process.env.GUPSHUP_SOURCE_NUMBER || "917075176108");
  console.log("src.name    :", process.env.GUPSHUP_APP_NAME || "(GUPSHUP_APP_NAME not set)");
  console.log("template    : pending_transaction_hkm");
  console.log("template id :", getPendingTemplateId());
  console.log("button param:", sendButtonParam ? `yes -> ${fields.suffix}` : "no");
  console.log("button URL  :", fields.link);
  console.log("params      :", JSON.stringify(params, null, 2));

  const headerImageUrl = await resolveJpegHeaderUrl(BANNER);
  console.log("header image:", headerImageUrl);
  if (headerImageUrl && !/\.(jpe?g|png)(\?|#|$)/i.test(headerImageUrl)) {
    console.warn(
      "  WARNING: not a .jpg/.png URL. Meta only accepts JPEG/PNG for image headers —\n" +
      "  the send will fail. Check R2_PUBLIC_URL / R2 credentials so the webp can be\n" +
      "  converted and re-hosted, or point WAPI_PENDING_IMAGE at a JPEG."
    );
  }

  if (dry) {
    console.log("\n--dry: nothing sent.");
    return;
  }

  if (!isGupshupConfigured()) {
    console.error("\nGupshup is not fully configured — set GUPSHUP_API_KEY, GUPSHUP_APP_NAME and GUPSHUP_PENDING_TEMPLATE_ID.");
    process.exit(1);
  }

  try {
    const result = await sendPendingWhatsappViaGupshup(
      phone,
      SAMPLE.donorName,
      SAMPLE.amount,
      SAMPLE.sevaName,
      { linkSuffix: SAMPLE.linkSuffix, sevaImage: BANNER }
    );
    console.log("\nSUBMITTED. messageId:", result.messageId);
    console.log("Check the phone — 'submitted' means Gupshup accepted it, not that Meta delivered it.");
  } catch (err) {
    console.error("\nFAILED:", err.message);
    if (err.sentParams) console.error("params sent:", JSON.stringify(err.sentParams));
    if (err.response) console.error("raw response:", JSON.stringify(err.response));
    process.exit(1);
  }
}

main();
