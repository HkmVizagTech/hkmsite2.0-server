// Pre-converts every seva banner to JPEG and re-hosts it on R2, so the
// pending-transaction reminder always has a Meta-acceptable header image
// ready. Run once after deploying, and again whenever SEVA_IMAGES changes.
//
//   node warm-seva-banners.js
//
// WHY THIS IS NEEDED
// The seva banners in R2 are .webp. Gupshup and Meta both refuse .webp for a
// template's image header, so gupshup.service.js converts each banner to JPEG
// and re-uploads it to R2 under whatsapp-headers/<hash>.jpg the first time it
// is used. That conversion needs the R2 credentials (R2_ACCOUNT_ID,
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL).
// If any of them is missing, every reminder silently falls back to the generic
// approval banner instead of the donor's own seva image. This script tells you
// which it is, per banner, before a real donor finds out.

require("dotenv").config();

const { SEVA_IMAGES, DEFAULT_SEVA_IMAGE } = require("./src/services/pendingReminder.service");
const { resolveJpegHeaderUrl } = require("./src/services/gupshup.service");

const FALLBACK_MARKER = "fss.gupshup.io";

async function main() {
  const entries = Object.entries(SEVA_IMAGES);
  entries.push(["(default / unmapped pages)", DEFAULT_SEVA_IMAGE]);

  const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn("R2 is not fully configured — missing:", missing.join(", "));
    console.warn("Every banner below will fall back to the generic approval image.\n");
  }

  let ok = 0;
  let fellBack = 0;

  for (const [page, source] of entries) {
    if (!source) {
      console.log(`SKIP  ${page} — no banner configured`);
      continue;
    }
    try {
      const resolved = await resolveJpegHeaderUrl(source);
      if (!resolved || resolved.includes(FALLBACK_MARKER)) {
        fellBack += 1;
        console.log(`FALLBACK  ${page}\n          -> generic banner (conversion or upload failed)`);
      } else {
        ok += 1;
        console.log(`OK        ${page}\n          -> ${resolved}`);
      }
    } catch (err) {
      fellBack += 1;
      console.log(`ERROR     ${page}: ${err.message}`);
    }
  }

  console.log(`\n${ok} banner(s) ready as JPEG, ${fellBack} falling back to the generic image.`);
  if (fellBack) {
    console.log("Fix the R2 variables above, or upload JPEG/PNG versions of those banners");
    console.log("and point SEVA_IMAGES in src/services/pendingReminder.service.js at them.");
    process.exitCode = 1;
  }
}

main();
