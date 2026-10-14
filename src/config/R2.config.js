import { S3Client } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID || "";
if (!accountId) {
  console.error(
    "[R2] WARNING: R2_ACCOUNT_ID is not set — uploads will fail with a confusing " +
      "SSL handshake error. Set it in Railway → Variables."
  );
}
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

const r2Client = new S3Client({
  region: "auto",
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.R2_BUCKET_NAME;

export { r2Client, bucketName };
