import fs from "node:fs";
import path from "node:path";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, bucketName } from "../config/R2.config.js";

const sharp = await import("sharp")
  .then((m) => m.default)
  .catch((e) => {
    console.warn("r2.js: sharp not available, uploads will skip compression:", e.message);
    return null;
  });

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
  let width,
    height,
    outFormat = ext.replace(".", "");

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

export { uploadToR2, deleteFromR2 };
