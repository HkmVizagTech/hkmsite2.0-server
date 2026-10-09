// Why payments fail — keeps Razorpay's own explanation instead of a bare
// "failed" status, so Admin → Donations → Payment failures can show the real
// reasons (bank declined, UPI request expired, cancelled by the donor…) and the
// bank / UPI-app / card-network downtimes Razorpay announced.

const mongoose = require("mongoose");
const { donationModel } = require("../models/donation.model");

/** The fields worth keeping from a failed Razorpay payment entity. */
function paymentErrorFrom(p) {
  if (!p) return null;
  return {
    paymentId: p.id,
    code: p.error_code || undefined, // e.g. BAD_REQUEST_ERROR, GATEWAY_ERROR
    description: p.error_description || undefined, // human text Razorpay shows the donor
    source: p.error_source || undefined, // customer | bank | business | gateway | internal
    step: p.error_step || undefined, // payment_initiation | payment_authentication | payment_authorization
    reason: p.error_reason || undefined, // e.g. payment_cancelled, payment_timed_out, insufficient_funds
    method: p.method || undefined, // upi | card | netbanking | wallet
    bank: p.bank || undefined,
    wallet: p.wallet || undefined,
    upiFlow: (p.upi && p.upi.flow) || undefined, // intent | collect | in_app
    cardNetwork: (p.card && p.card.network) || undefined,
    at: p.created_at ? new Date(p.created_at * 1000) : new Date(),
  };
}

/** Stores the latest failure on the donation and counts the attempt (never touches status). */
async function recordPaymentFailure(donationId, payment) {
  const err = paymentErrorFrom(payment);
  if (!donationId || !err) return;
  await donationModel.updateOne(
    { _id: donationId, "paymentError.paymentId": { $ne: err.paymentId } }, // idempotent per payment
    { $set: { paymentError: err }, $inc: { failedAttempts: 1 } }
  );
}

// ── Razorpay downtime alerts (payment.downtime.started / updated / resolved) ──
const downtimeSchema = new mongoose.Schema(
  {
    downtimeId: { type: String, index: true },
    event: String, // started | updated | resolved
    method: String, // upi | card | netbanking | wallet
    instrument: mongoose.Schema.Types.Mixed, // { bank } | { psp } | { network } | { vpa_handle } …
    severity: String, // high | medium | low
    status: String,
    begin: Date,
    end: Date,
    receivedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
downtimeSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // keep 30 days
const paymentDowntimeModel = mongoose.models.paymentDowntime || mongoose.model("paymentDowntime", downtimeSchema);

async function recordDowntime(eventName, payload) {
  const d = payload && payload.payment && payload.payment.downtime && payload.payment.downtime.entity;
  if (!d) return;
  const doc = {
    downtimeId: d.id,
    event: String(eventName || "").replace("payment.downtime.", ""),
    method: d.method,
    instrument: d.instrument || {},
    severity: d.severity,
    status: d.status,
    begin: d.begin ? new Date(d.begin * 1000) : undefined,
    end: d.end ? new Date(d.end * 1000) : undefined,
  };
  await paymentDowntimeModel.create(doc);
  const what = Object.values(doc.instrument || {}).filter(Boolean).join("/") || "all";
  console.log(`[downtime] ${doc.event} · ${doc.method || "?"} · ${what} · severity ${doc.severity || "?"}`);
}

module.exports = { paymentErrorFrom, recordPaymentFailure, recordDowntime, paymentDowntimeModel };
