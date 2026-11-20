const mongoose = require("mongoose");

// One registration for a Program (see program.model.js).
//   pending — registered, fee not paid yet (checkout open, closed, or abandoned)
//   paid    — fee received (Razorpay verified / webhook, or marked by an admin)
//   failed  — Razorpay reported the payment failed and nothing was captured
//   free    — program has no fee; registration is complete as submitted
const programRegistrationSchema = new mongoose.Schema(
  {
    programId: { type: mongoose.Schema.Types.ObjectId, ref: "Program", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 }, // participant (the child, for kids' programs)
    age: { type: Number, min: 0, max: 120 },
    parentName: { type: String, trim: true, default: "", maxlength: 120 },
    mobile: { type: String, required: true, index: true }, // 10 digits — WhatsApp goes here
    email: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
    venue: { type: String, trim: true, default: "", maxlength: 80 },
    note: { type: String, trim: true, default: "", maxlength: 500 },

    amount: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ["pending", "paid", "failed", "free"], default: "pending", index: true },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String },
    paidAt: { type: Date },
    failureReason: { type: String, default: "", maxlength: 300 },
    // Set when an admin marks a registration paid by hand (cash / UPI at the venue).
    manualPayment: {
      mode: { type: String, trim: true, maxlength: 40 },
      note: { type: String, trim: true, maxlength: 200 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
      at: { type: Date },
    },

    whatsapp: {
      status: { type: String, enum: ["not_sent", "sending", "sent", "failed"], default: "not_sent" },
      sentAt: { type: Date },
      error: { type: String, maxlength: 300 },
    },

    utm: {
      source: String,
      medium: String,
      campaign: String,
      content: String,
      term: String,
    },
  },
  { timestamps: true, versionKey: false, collection: "program_registrations" }
);

programRegistrationSchema.index({ programId: 1, createdAt: -1 });

const programRegistrationModel = mongoose.model("ProgramRegistration", programRegistrationSchema);
module.exports = { programRegistrationModel };
