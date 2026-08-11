const mongoose = require("mongoose");


const donationSchema = new mongoose.Schema({
  donorName: { type: String, required: true },
  donorEmail: { type: String },
  donorMobile: { type: String },
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  type: { type: String, default: "General" }, // e.g., "Anna Daan", "Seva", etc.
  status: { type: String, enum: ["pending", "active", "completed", "failed", "cancelled"], default: "pending" },
  message: { type: String },
  sourcePage: { type: String },
  sevaName: { type: String },
  legacySevaId: { type: Number },
  paymentAccount: { type: String },
  transactionId: { type: String },
  festivalId: { type: mongoose.Schema.Types.ObjectId, ref: "festivalDonation" },
  festivalSlug: { type: String },
  campaignerSlug: { type: String, index: true }, // P2P campaign attribution (SQFT, Janmashtami, ...)
  // Snapshot of the DCC enrolledBy ID for the temple devotee this donation
  // is attributed to (via the campaigner's selected devotee), captured at
  // order-creation time. When present, DCC sync uses this instead of the
  // env-based defaults, so the receipt is raised under that devotee.
  dccEnrolledById: { type: Number, default: null },
  utm: {
    source: { type: String, default: "" },
    medium: { type: String, default: "" },
    campaign: { type: String, default: "" },
    content: { type: String, default: "" },
    term: { type: String, default: "" },
  },
  panNumber: { type: String },
  certificate: { type: Boolean, default: false },
  sevakName: { type: String },
  sevaDate: { type: String },
  dob: { type: String },
  wantPrasadam: { type: Boolean, default: false },
  prasadamAddress: {
    doorNo: String,
    house: String,
    street: String,
    area: String,
    country: { type: String, default: 'India' },
    state: String,
    city: String,
    pincode: String,
  },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  // Manual entry support — for donations that arrived OUTSIDE the website
  // checkout flow entirely (direct bank transfer, UPI paid straight to the
  // temple's VPA, cash/cheque) or for stuck on-site attempts where the
  // donor paid but couldn't complete the flow. Admin enters these by hand
  // in /admin/donations → Manual Entry, using the bank/UPI reference (UTR)
  // to identify the payment instead of a Razorpay ID.
  manualEntry: { type: Boolean, default: false },
  utrNumber: { type: String, trim: true },
  manualPaymentMode: { type: String, enum: ["upi", "bank", "cash", "cheque"], default: undefined },
  manualEntryNote: { type: String, trim: true },
  manualEnteredBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  subscriptionId: { type: String },
  isRecurring: { type: Boolean, default: false },
  lastPaymentDate: { type: Date },
  receiptNumber: { type: String },
  receiptGeneratedAt: { type: Date },
  dccSyncStatus: { type: String, enum: ["pending", "syncing", "synced", "failed"], default: "pending" },
  // Set by the reconcile-pending admin tool each time a still-pending
  // donation is checked against Razorpay and found NOT captured (genuinely
  // abandoned, or some other non-success status) — without this, oldest-
  // first batches would re-check the same already-confirmed-abandoned
  // records forever instead of progressing through the backlog.
  lastReconcileCheckAt: { type: Date, default: null },
  dccSyncedAt: { type: Date },
  dccLastAttemptAt: { type: Date },
  dccSyncError: { type: String },
  dccPayload: { type: mongoose.Schema.Types.Mixed },
  dccResponse: { type: mongoose.Schema.Types.Mixed },
  whatsappReceiptSentAt: { type: Date },
  whatsappReceiptError: { type: String },
  // Meta (Facebook) Pixel + Conversions API. Captured at order-creation
  // from the browser so the server-side Purchase event (fired on payment
  // completion) can be deduplicated against the browser pixel event
  // (same metaEventId) and attributed to the right ad click (fbc/fbp).
  metaEventId: { type: String },
  metaFbp: { type: String },
  metaFbc: { type: String },
  metaClientIp: { type: String },
  metaUserAgent: { type: String },
  metaPurchaseSentAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }
}, {
  timestamps: true,
  versionKey: false
});

donationSchema.index({ festivalId: 1 });
donationSchema.index({ date: -1 });
donationSchema.index({ status: 1 });
donationSchema.index({ razorpayOrderId: 1 });
donationSchema.index({ donorMobile: 1 });
donationSchema.index({ utrNumber: 1 });

const donationModel = mongoose.model("donation", donationSchema);

module.exports = { donationModel };
