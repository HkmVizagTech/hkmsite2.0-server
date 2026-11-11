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
    // Short code from the temple's devotee list (e.g. "ABRD"). A seva page link ending in the code or the
    // DCC id (/anna-daan-seva/ABRD or /anna-daan-seva/1) credits that page's donations to this devotee.
    code: { type: String, trim: true, uppercase: true, default: undefined },
    mobile: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    status: { type: String, enum: ["active", "hidden"], default: "active" },
  },
  { timestamps: true, versionKey: false }
);

templeDevoteeSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: "string" } } });

const templeDevoteeModel = mongoose.model("templeDevotee", templeDevoteeSchema);

module.exports = { templeDevoteeModel };
