// src/config/R2.config.js
// Cloudflare R2 client — same account/bucket pattern already used in
// campaign-server (HkmVizagTech's campaigner platform). CommonJS here
// since hkmsite2.0-server is not an ESM package (campaign-server is).
const { S3Client } = require("@aws-sdk/client-s3");

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.R2_BUCKET_NAME;

module.exports = { r2Client, bucketName };
