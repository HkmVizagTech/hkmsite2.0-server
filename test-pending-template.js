// Verifies the pending-transaction WhatsApp template end to end.
//
//   node test-pending-template.js 919876543210
//
// Reads the template name from WAPI_PENDING_TEMPLATE_NAME (default
// pending_seva_notice) and sends it exactly the way the reminder job does:
// the seva banner converted to JPEG and attached as binary header media,
// 4 body params, and NO button component.
//
// Reminder — Flaxxa cannot fill a {{1}} in a button URL. If this script
// reports a failure mentioning (#131008) / "message_wamid was null", check
// that the template's button URL is STATIC (no {{1}}) in the Flaxxa template
// editor. That is the single most common cause.

require("dotenv").config();

const { sendPendingWhatsapp } = require("./src/services/whatsapp.service");

const BANNER =
  process.env.WAPI_PENDING_IMAGE ||
  "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1785588189215-1785588187426-brick-hero-desk.webp";

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: node test-pending-template.js <phone>");
    process.exit(1);
  }
  if (!process.env.WAPI_TOKEN) {
    console.error("WAPI_TOKEN is not set in .env");
    process.exit(1);
  }

  console.log("template :", process.env.WAPI_PENDING_TEMPLATE_NAME || "pending_seva_notice");
  console.log("language :", process.env.WAPI_TEMPLATE_LANG || "en");
  console.log("banner   :", BANNER);
  console.log("");

  try {
    const result = await sendPendingWhatsapp(phone, "Test Devotee", 100, "Brick Seva", {
      linkSuffix: "brick-seva-campaign",
      sevaImage: BANNER,
    });
    console.log("DELIVERED. wamid:", result.message_wamid);
  } catch (err) {
    console.error("FAILED:", err.message);
    if (err.response) console.error("raw response:", JSON.stringify(err.response));
    process.exit(1);
  }
}

main();
