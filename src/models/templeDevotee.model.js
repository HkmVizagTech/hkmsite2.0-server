const mongoose = require("mongoose");

// Curated list of temple devotees (counselors/preachers) maintained by
// admin. Campaigner registrants pick "a devotee they know" from this list;
// donations made through that campaigner's link are then synced to DCC
// with enrolledBy = that devotee's DCC ID, so the receipt is attributed
// to the devotee's outreach.
const templeDevoteeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // DCC "enrolledBy" numeric ID for this devotee. Optional — if absent,
    // donations attributed to them fall back to the env-based defaults.
    dccEnrolledById: { type: Number, default: null },
    status: { type: String, enum: ["active", "hidden"], default: "active" },
  },
  { timestamps: true, versionKey: false }
);

const templeDevoteeModel = mongoose.model("templeDevotee", templeDevoteeSchema);

module.exports = { templeDevoteeModel };
