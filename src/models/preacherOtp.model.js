const mongoose = require("mongoose");

// One pending login code per mobile number for the preacher portal. Only the SHA-256 of the code is stored.
const preacherOtpSchema = new mongoose.Schema(
  {
    _id: { type: String }, // 10-digit mobile
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
    // how the last code went out (for tracing a late or missing SMS with the provider)
    smsAckId: { type: String, default: null },
    smsError: { type: String, default: null },
    whatsappSent: { type: Boolean, default: false },
    whatsappError: { type: String, default: null },
  },
  { versionKey: false, collection: "preacher_otps" }
);
// Mongo removes the row an hour after it expires.
preacherOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const preacherOtpModel = mongoose.model("preacherOtp", preacherOtpSchema);
module.exports = { preacherOtpModel };
