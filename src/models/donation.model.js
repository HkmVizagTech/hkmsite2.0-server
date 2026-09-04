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
  // The seva's slug on its page ("abhisheka", "vastrabharana"), as sent by the
  // festival pages. sevaName is the display title and can be reworded between
  // years; this is the stable key the page's ?seva= deep link matches on, so
  // the pending-payment reminder can send a donor back to the exact seva they
  // abandoned. Absent on donations from pages that don't have per-seva slugs.
  sevaSlug: { type: String },
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
  // Atomic lock to guarantee a donor never receives two WhatsApp receipts
  // for the same transaction — set to "sending" for the duration of an
  // in-flight send attempt, cleared after (success or failure). See
  // sendDonationWhatsAppReceipt in paymentCompletion.service.js.
  whatsappSendStatus: { type: String, enum: ["sending"], default: undefined },
  whatsappReceiptError: { type: String },
  // Which number/API actually sent the receipt ("gupshup" | "flaxxa").
  // Recorded per donation because the provider is switchable at runtime via
  // RECEIPT_WHATSAPP_PROVIDER, so "which one sent this?" can't be answered
  // from the current env alone when investigating an old delivery.
  whatsappProvider: { type: String },
  // Provider's message id for the receipt send. This is the join key for the
  // Gupshup delivery callback (/webhooks/whatsapp/gupshup) — indexed because
  // every incoming event looks a donation up by it.
  whatsappMessageId: { type: String, index: true },
  // What the provider's callback last reported. "submitted" means the API
  // accepted it and nothing has come back yet — NOT that the donor received
  // it; only "delivered"/"read" mean that.
  whatsappDeliveryStatus: {
    type: String,
    enum: ["submitted", "enqueued", "sent", "delivered", "read", "failed"],
    default: undefined,
  },
  whatsappDeliveredAt: { type: Date },
  // Set once the "pending transaction" WhatsApp reminder has been sent for a
  // still-pending donation, so the reminder job never messages the same
  // donor twice about the same donation.
  whatsappPendingReminderSent: { type: Boolean, default: false },
  // Failed attempts at that reminder. The job only marks a donation as
  // reminded on a genuinely successful send, so without a cap a permanently
  // unsendable record (bad phone number, deleted template) would be retried
  // on every pass forever — and because the batch is ordered oldest-first
  // with a fixed limit, enough of them would starve newer donations out of
  // the batch entirely. Records past PENDING_REMINDER_MAX_ATTEMPTS are
  // skipped; whatsappPendingReminderError says why they gave up.
  whatsappPendingReminderAttempts: { type: Number, default: 0 },
  whatsappPendingReminderError: { type: String },
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
