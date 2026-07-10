// src/utils/r2.js
//
// Drop-in replacement for utils/cloudinary.js — same call signature
// (uploadToR2(filePath, folder)) and same response shape as Cloudinary's
// uploader.upload() ({ secure_url, public_id, format, width, height, bytes })
// so existing controllers (heroBanner, blog, event, registration, media)
// need only swap their require() line, nothing else.
//
// Unlike the campaigner platform's utils/R2.js (which hard-resizes every
// upload to 500px wide for small profile photos), this preserves original
// dimensions — hero banners and blog hero images need full resolution —
// and only applies lossless-ish compression to shrink file size.

const fs = require("fs");
const path = require("path");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { r2Client, bucketName } = require("../config/R2.config");

// sharp is optional — it compresses images before upload.
// On Alpine Linux (Railway's Dockerfile base) sharp needs native vips libs;
// if they're missing the module fails to load. We catch that here and fall
// back to uploading the original buffer uncompressed. Vercel's next/image
// optimizer handles client-side resize/compression anyway.
let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  console.warn("r2.js: sharp not available, uploads will skip compression:", e.message);
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

const uploadToR2 = async (filePath, folder = "media") => {
  const ext = path.extname(filePath).toLowerCase();
  const mimetype = MIME_BY_EXT[ext] || "application/octet-stream";

  let buffer = fs.readFileSync(filePath);
  let width, height, outFormat = ext.replace(".", "");

  if (sharp) {
    try {
      if (mimetype === "image/jpeg") {
        const img = sharp(buffer).jpeg({ quality: 85, mozjpeg: true });
        const meta = await img.metadata();
        width = meta.width;
        height = meta.height;
        buffer = await img.toBuffer();
      } else if (mimetype === "image/png") {
        const img = sharp(buffer).png({ compressionLevel: 8 });
        const meta = await img.metadata();
        width = meta.width;
        height = meta.height;
        buffer = await img.toBuffer();
      } else if (mimetype === "image/webp") {
        const img = sharp(buffer).webp({ quality: 85 });
        const meta = await img.metadata();
        width = meta.width;
        height = meta.height;
        buffer = await img.toBuffer();
      }
    } catch (e) {
      console.warn("r2.uploadToR2: sharp processing skipped:", e.message);
      buffer = fs.readFileSync(filePath);
    }
  }

  const safeBase = path
    .basename(filePath, ext)
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9.-]/g, "");
  const key = `${folder}/${Date.now()}-${safeBase}${ext}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

  return {
    secure_url: `${publicBase}/${key}`,
    public_id: key, // R2 object key — pass this to deleteFromR2 later
    format: outFormat,
    width,
    height,
    bytes: buffer.length,
  };
};

const deleteFromR2 = async (key) => {
  if (!key) return;
  await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
};

module.exports = { uploadToR2, deleteFromR2 };
