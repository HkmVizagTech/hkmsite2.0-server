const mongoose = require("mongoose");

// Peer-to-peer fundraising campaigner. Originally Square Foot Seva only;
// now supports multiple campaign types (SQFT, JANMASHTAMI). Each campaigner
// gets a public page (e.g. /sqft-seva-campaign/c/[slug] or /janmashtami/c/[slug])
// and donations made through that page carry donation.campaignerSlug = slug.
//
// APPROVAL FLOW: new registrations start as "pending" and only become
// publicly visible (and their link functional) once an admin approves them
// by setting status to "active".
const campaignerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    mobile: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    campaignType: { type: String, enum: ["SQFT", "JANMASHTAMI"], default: "SQFT", index: true },
    // The temple devotee this campaigner knows — selected at registration.
    // Donations through this campaigner's link are attributed to this
    // devotee in DCC (enrolledBy = devotee.dccEnrolledById).
    referredByDevotee: { type: mongoose.Schema.Types.ObjectId, ref: "templeDevotee", default: null },
    goalSqft: { type: Number, default: 0, min: 0, max: 100000 },
    message: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ["pending", "active", "hidden"], default: "pending" },
  },
  { timestamps: true, versionKey: false }
);

campaignerSchema.index({ email: 1 });

const campaignerModel = mongoose.model("campaigner", campaignerSchema);

module.exports = { campaignerModel };
