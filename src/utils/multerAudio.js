// Separate multer instance for bhajan audio (60 MB, audio only), so the global
// image uploader's 10 MB limit stays untouched.
const multer = require("multer");
const path = require("path");
const os = require("os");
const { AUDIO_MIME_BY_EXT } = require("./r2Audio");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "")),
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const okMime = /^audio\//.test(file.mimetype) || file.mimetype === "video/mp4";
  if (okMime && AUDIO_MIME_BY_EXT[ext]) return cb(null, true);
  cb(new Error("Only audio files (mp3, m4a, wav, ogg) are allowed!"), false);
};

const uploadAudio = multer({
  storage,
  fileFilter,
  limits: { fileSize: 60 * 1024 * 1024 },
});

module.exports = uploadAudio;
