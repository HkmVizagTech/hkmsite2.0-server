// Raw audio upload to R2 (no sharp, no re-encoding). Mirrors the return shape
// of uploadToR2 so callers can treat both the same.
const fs = require("fs");
const path = require("path");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { r2Client, bucketName } = require("../config/R2.config");

const AUDIO_MIME_BY_EXT = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
};

const uploadAudioToR2 = async (filePath, folder = "bhajans/audio") => {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = AUDIO_MIME_BY_EXT[ext];
  if (!contentType) throw new Error(`Unsupported audio type: ${ext || "(none)"}`);

  const buffer = fs.readFileSync(filePath);
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
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const publicBase = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  return { secure_url: `${publicBase}/${key}`, public_id: key, bytes: buffer.length };
};

module.exports = { uploadAudioToR2, AUDIO_MIME_BY_EXT };
