// src/config/R2.config.js
// Cloudflare R2 client — same account/bucket pattern already used in
// campaign-server (HkmVizagTech's campaigner platform). CommonJS here
// since hkmsite2.0-server is not an ESM package (campaign-server is).
const { S3Client } = require("@aws-sdk/client-s3");

const accountId = process.env.R2_ACCOUNT_ID || "";
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

// Log on startup so we can verify the correct values are set in Railway.
console.log("[R2] endpoint  :", endpoint);
console.log("[R2] bucket    :", process.env.R2_BUCKET_NAME || "(not set)");
console.log("[R2] public URL:", process.env.R2_PUBLIC_URL || "(not set)");
console.log("[R2] key ID    :", process.env.R2_ACCESS_KEY_ID ? process.env.R2_ACCESS_KEY_ID.slice(0, 6) + "..." : "(not set)");

const r2Client = new S3Client({
  region: "auto",
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.R2_BUCKET_NAME;

module.exports = { r2Client, bucketName };
