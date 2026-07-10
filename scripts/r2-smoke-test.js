// One-off sanity check — run manually with real R2 env vars set:
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   R2_BUCKET_NAME=... R2_PUBLIC_URL=... node scripts/r2-smoke-test.js
// Uploads a tiny 1x1 PNG, prints the public URL, then deletes it.
// Not part of the app — safe to delete after use.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { uploadToR2, deleteFromR2 } = require("../src/utils/r2");

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

(async () => {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }

  const tmpFile = path.join(os.tmpdir(), "r2-smoke-test.png");
  fs.writeFileSync(tmpFile, Buffer.from(TINY_PNG_BASE64, "base64"));

  console.log("Uploading test image to R2...");
  const result = await uploadToR2(tmpFile, "smoke-test");
  console.log("Uploaded:", result);
  console.log("Public URL:", result.secure_url);

  console.log("Deleting test image from R2...");
  await deleteFromR2(result.public_id);
  console.log("Deleted. R2 integration is working end-to-end.");

  fs.unlinkSync(tmpFile);
})().catch((err) => {
  console.error("R2 smoke test FAILED:", err);
  process.exit(1);
});
