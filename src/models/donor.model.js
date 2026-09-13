const mongoose = require("mongoose");

// A lightweight identity record per donor, keyed by mobile number (the
// most reliable identifier Indian donors consistently provide). Built now
// to support preacher-donor assignment, but designed to also carry the
// donor login portal later without needing rework — same record, same
// donorId, same assignedPreacherId field either way.
const donorSchema = new mongoose.Schema(
  {
    // Human-friendly ID shown to the donor and staff, e.g. "HKM-2026-00001".
    // Generated once, on first creation, never changes.
    donorId: { type: String, required: true, unique: true },
    mobile: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String },
    assignedPreacherId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    // Set when a preacher raises a receipt for a brand-new donor —
    // distinguishes "assigned because this preacher brought them in" from
    // a later manual reassignment by admin (assignedPreacherId still
    // reflects who they're CURRENTLY assigned to; this records who first
    // brought them into the system, for reference).
    firstRaisedByPreacherId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

const donorModel = mongoose.model("donor", donorSchema);
module.exports = { donorModel };
