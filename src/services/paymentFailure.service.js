import { paymentDowntimes } from "../db/tables.js";
import { claimUpdate, wholePaymentError } from "../domain/donationDb.js";

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
  await claimUpdate(
    { _id: String(donationId), "paymentError.paymentId": { $ne: err.paymentId } }, // idempotent per payment
    { $set: { paymentError: wholePaymentError(err) }, $inc: { failedAttempts: 1 } }
  );
}

// ── Razorpay downtime alerts (payment.downtime.started / updated / resolved) ──
// Mongo expired these with a 30-day TTL index; Postgres has none, so old rows are pruned as new ones arrive.
const paymentDowntimeModel = paymentDowntimes;

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
  await paymentDowntimes.insert(doc);
  paymentDowntimes
    .deleteMany({ $raw: ["received_at < now() - interval '30 days'", []] })
    .catch((e) => console.warn("[downtime] cleanup failed:", e && e.message ? e.message : e));
  const what =
    Object.values(doc.instrument || {})
      .filter(Boolean)
      .join("/") || "all";
  console.log(`[downtime] ${doc.event} · ${doc.method || "?"} · ${what} · severity ${doc.severity || "?"}`);
}

export { paymentErrorFrom, recordPaymentFailure, recordDowntime, paymentDowntimeModel };
