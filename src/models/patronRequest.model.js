const mongoose = require("mongoose");

// A "Become a Patron" form submission from the public /patron page. DRM pulls
// these (GET /api/internal/drm/patron-requests) and turns each one into a call
// lead, so this record stays a faithful copy of what the visitor typed; the
// follow-up (who called, status, recordings) lives in DRM, not here.
const patronRequestSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true, default: "" },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    // 10-digit Indian mobile, without +91 - the same form DRM matches donors on.
    mobile: { type: String, required: true, trim: true, index: true },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },
    authorization: { type: Boolean, default: false },
    source: { type: String, default: "patron-page" },
  },
  { timestamps: true, versionKey: false }
);

patronRequestSchema.index({ createdAt: -1 });

const patronRequestModel = mongoose.model("patronRequest", patronRequestSchema);

module.exports = { patronRequestModel };
