const mongoose = require("mongoose");

// Peer-to-peer fundraising campaigner for the Square Foot Seva campaign.
// Each campaigner gets a public page at /sqft-seva-campaign/c/[slug] and
// donations made through that page carry donation.campaignerSlug = slug.
const campaignerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    mobile: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    goalSqft: { type: Number, default: 0, min: 0, max: 100000 },
    message: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ["active", "hidden"], default: "active" },
  },
  { timestamps: true, versionKey: false }
);

campaignerSchema.index({ email: 1 });

const campaignerModel = mongoose.model("campaigner", campaignerSchema);

module.exports = { campaignerModel };
