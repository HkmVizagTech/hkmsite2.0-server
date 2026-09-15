const mongoose = require("mongoose");

// A lightweight identity record per donor, keyed by mobile number (the
// most reliable identifier Indian donors consistently provide). Built now
// to support preacher-donor assignment, but designed to also carry the
// donor login portal later without needing rework — same record, same
// donorId, same assignedPreacherId field either way.
const donorSchema = new mongoose.Schema(
  {
    // Human-friendly ID shown to the donor and staff, e.g. "HKM-2026-00001".
    // Generated once, on first creation, never changes. Acts as a fallback
    // identifier only until DCC has synced at least one donation for this
    // donor — see dccDonorNumber below, which is the REAL, authoritative
    // one once it exists.
    donorId: { type: String, required: true, unique: true },
    // DCC's own official donor number (e.g. "D49822"), returned as
    // DonorNumber in their addDonation API response. This is DCC's real
    // CRM identifier for this donor — should be preferred everywhere a
    // donor's ID is shown once it's known. Not set until their first
    // donation successfully syncs to DCC (a donor who's only ever had a
    // pending/failed payment, or whose only donation is a manual entry
    // that hasn't synced yet, won't have this - donorId above covers
    // that gap).
    dccDonorNumber: { type: String, index: true, sparse: true },
    mobile: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    email: { type: String },
    assignedPreacherId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    // Set when a preacher raises a receipt for a brand-new donor —
    // distinguishes "assigned because this preacher brought them in" from
    // a later manual reassignment by admin (assignedPreacherId still
    // reflects who they're CURRENTLY assigned to; this records who first
    // brought them into the system, for reference).
    firstRaisedByPreacherId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },

    // ---- Donor login (mobile + WhatsApp OTP) ----
    // The OTP itself is stored hashed (bcrypt, same as user passwords),
    // never in plaintext, even though it's short-lived.
    otpCodeHash: { type: String },
    otpExpiresAt: { type: Date },
    otpAttempts: { type: Number, default: 0 }, // wrong-code tries against the current OTP; capped to stop brute-forcing a 6-digit code
    otpLastRequestedAt: { type: Date }, // for rate-limiting how often a new OTP can be requested
  },
  { timestamps: true, versionKey: false }
);

const donorModel = mongoose.model("donor", donorSchema);
module.exports = { donorModel };
