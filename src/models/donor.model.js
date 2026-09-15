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
    name: { type: String, required: true, index: true },
    email: { type: String },
    // Donor-level PAN, entered once from the login portal (My Profile) so it
    // can be reused as the default for future 80G-eligible donations. This is
    // separate from donation.panNumber, which stays the per-donation value
    // actually printed on that donation's certificate — editing the profile
    // PAN here never rewrites history on past donations.
    panNumber: { type: String, trim: true, uppercase: true },
    // Saved delivery address for Maha Prasadam courier, so a returning donor
    // isn't retyping it on every seva booking. Same shape as
    // donation.prasadamAddress; kept as a plain subdocument (no _id) since
    // a donor only ever has one saved address at a time.
    savedAddress: {
      _id: false,
      type: {
        street: { type: String, trim: true },
        city: { type: String, trim: true },
        state: { type: String, trim: true },
        pincode: { type: String, trim: true },
        country: { type: String, trim: true, default: "India" },
      },
      default: undefined,
    },
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
