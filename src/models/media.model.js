const mongoose = require("mongoose");

// Admin media library — reusable uploaded assets (images) whose Cloudinary
// URLs can be pasted anywhere across the site (banners, blogs, seva pages…).
const mediaSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    format: { type: String },
    width: { type: Number },
    height: { type: Number },
    bytes: { type: Number },
    folder: { type: String, default: "media-library" },
    tags: { type: String, trim: true }, // free-text, e.g. "sqft campaign hero"
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

mediaSchema.index({ createdAt: -1 });
mediaSchema.index({ name: "text", tags: "text" });

const mediaModel = mongoose.model("media", mediaSchema);

module.exports = { mediaModel };
