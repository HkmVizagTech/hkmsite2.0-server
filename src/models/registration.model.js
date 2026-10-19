const mongoose = require("mongoose");

const registrationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "event", required: true },
  token: { type: String, required: true, unique: true },
  data: { type: Object, default: {} },
  files: [{ type: String }],
  paid: { type: Boolean, default: false },
  // Events with a registration fee (registrationForm.payment.enabled): the
  // option chosen (student | job | general), the amount charged — always
  // taken from the event, never from the browser — and the Razorpay order.
  // not_required = free event; pending = registered, payment not completed.
  paymentChoice: { type: String },
  amount: { type: Number },
  paymentStatus: { type: String, enum: ["not_required", "pending", "paid"], default: "not_required" },
  razorpayOrderId: { type: String, index: true },
  razorpayPaymentId: { type: String },
  paidAt: { type: Date },
  attendance: {
    present: { type: Boolean, default: false },
    at: { type: Date },
    scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }
  }
}, { timestamps: true, versionKey: false });

const registrationModel = mongoose.model("registration", registrationSchema);

module.exports = { registrationModel };
