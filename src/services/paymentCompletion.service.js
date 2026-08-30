const fs = require("fs");
const os = require("os");
const path = require("path");
const { donationModel } = require("../models/donation.model");
const { syncDonationToDcc } = require("./dcc.service");
const {
  isWhatsAppConfigured,
  sendTemplateMessageWithAttachment,
} = require("./whatsapp.service");
const { generateReceiptBuffer } = require("./receipt.service");

// Approved Meta template for the receipt-with-PDF message. Confirmed from
// the real approved template: body expects 3 params — donor name
// ({{body_1}}), amount ({{body_2}}), seva/purpose ({{body_3}}).
// Per policy, this is the ONLY WhatsApp message this donation flow ever
// sends — no plain-text fallback when there's no receipt yet (see
// sendDonationWhatsAppReceipt below).
const RECEIPT_TEMPLATE_NAME = process.env.WAPI_RECEIPT_TEMPLATE_NAME || "common_donation_success_reciept";

// Isolated on purpose: a WhatsApp failure (bad template name, Meta outage,
// invalid phone) must NEVER undo or break the donation record — the payment
// already succeeded and DCC (if configured) already has its own record.
// This mirrors the fix applied in subhojanam-server, where DCC, receipt
// generation, and WhatsApp send are each wrapped separately so one failing
// doesn't cascade into losing the others.
async function sendDonationWhatsAppReceipt(donation, { force = false } = {}) {
  if (!isWhatsAppConfigured()) return { ok: false, skipped: true, reason: "whatsapp_not_configured" };
  if (!donation.donorMobile) return { ok: false, skipped: true, reason: "no_phone_number" };

  // No receipt number yet (DCC hasn't synced, or failed) -- per policy, no
  // WhatsApp message goes out at all until there's a real receipt to send.
  // This used to fall back to a plain "thank you" text template, but that
  // meant donors could get a WhatsApp message implying their donation was
  // fully processed even when DCC had actually failed (e.g. the DCC-side
  // duplicate-donor / outage cases found while debugging real donations).
  // The admin "Resend WhatsApp" action re-checks this same condition, so
  // once DCC is manually resynced, sending the real receipt is one click.
  if (!donation.receiptNumber) {
    return { ok: false, skipped: true, reason: "no_receipt_yet" };
  }

  // HARD IDEMPOTENCY GUARD — a donor must NEVER receive two receipts for
  // the same transaction, "at any cost". This matters because
  // runPostCompletionPipeline (and therefore this function) can genuinely
  // be invoked more than once for the same already-completed donation —
  // Razorpay itself can and does deliver the same webhook event twice
  // (documented behavior; merchants are expected to handle it
  // idempotently), and completeDonation() previously re-ran the full
  // pipeline even when the donation was already completed before this fix.
  //
  // force=true is the ONLY way past this — reserved for the explicit
  // admin "Resend WhatsApp" action, a deliberate, human-initiated resend
  // (e.g. donor says they never received it), never for anything automatic.
  if (!force && donation.whatsappReceiptSentAt) {
    return { ok: true, skipped: true, reason: "already_sent" };
  }

  // Atomic lock — prevents a genuine concurrent double-send even under
  // force (e.g. an admin double-clicking "Resend" quickly, or an
  // automatic pipeline call racing a manual resend at the same instant).
  const lockQuery = { _id: donation._id, whatsappSendStatus: { $ne: "sending" } };
  if (!force) lockQuery.whatsappReceiptSentAt = { $in: [null, undefined] };

  const lock = await donationModel.findOneAndUpdate(
    lockQuery,
    { whatsappSendStatus: "sending" },
    { new: true }
  );
  if (!lock) {
    if (!force) {
      const latest = await donationModel.findById(donation._id);
      if (latest?.whatsappReceiptSentAt) return { ok: true, skipped: true, reason: "already_sent" };
    }
    return { ok: false, skipped: true, reason: "send_in_progress" };
  }

  const amountText = `Rs. ${Number(donation.amount || 0).toLocaleString("en-IN")}`;
  let tmpFile = null;
  try {
    const pdfBytes = await generateReceiptBuffer(donation._id);
    tmpFile = path.join(os.tmpdir(), `receipt-${donation._id}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, pdfBytes);

    await sendTemplateMessageWithAttachment(
      donation.donorMobile,
      RECEIPT_TEMPLATE_NAME,
      [
        { type: "text", text: donation.donorName || "Devotee" },
        { type: "text", text: amountText.replace(/^Rs\.\s*/, "") },
        { type: "text", text: donation.sevaName || donation.type || "Seva" },
      ],
      tmpFile,
      `Donation_Receipt_${String(donation.donorName || "Donor").replace(/\s+/g, "_")}.pdf`
    );

    await donationModel.findByIdAndUpdate(donation._id, {
      whatsappReceiptSentAt: new Date(),
      whatsappReceiptError: null,
      whatsappSendStatus: null,
    });
    return { ok: true, withPdf: true };
  } catch (error) {
    // PDF generation or the WhatsApp send itself failed -- still no
    // message goes out (per policy), just record why for admin visibility.
    const message = error && error.message ? error.message : String(error);
    console.error("WhatsApp PDF receipt failed for donation", donation._id.toString(), message);
    await donationModel.findByIdAndUpdate(donation._id, { whatsappReceiptError: message, whatsappSendStatus: null });
    return { ok: false, error: message };
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
}

// Fast path: marks the donation as completed and sets payment IDs.
// Returns the donation document (or null if not found).
async function markDonationCompleted({ donationId, orderId, paymentId }) {
  const query = donationId
    ? { _id: donationId }
    : { razorpayOrderId: orderId };

  let donation = await donationModel.findOneAndUpdate(
    { ...query, status: { $ne: "completed" } },
    {
      status: "completed",
      ...(paymentId
        ? {
            razorpayPaymentId: paymentId,
            transactionId: paymentId,
          }
        : {}),
    },
    { new: true }
  );

  if (!donation) {
    donation = await donationModel.findOne(query);
  }

  if (!donation) return null;

  if (paymentId && (!donation.razorpayPaymentId || !donation.transactionId)) {
    donation = await donationModel.findByIdAndUpdate(
      donation._id,
      {
        razorpayPaymentId: paymentId,
        transactionId: paymentId,
      },
      { new: true }
    );
  }

  return donation;
}

// Background pipeline: DCC sync, WhatsApp receipt, Meta CAPI.
// Each step is isolated — a failure in one doesn't block the others.
// DCC and WhatsApp are fire-and-forget: any failures are recorded on the
// donation record for the Needs Manual Receipt / Needs WhatsApp admin
// tabs, and the scheduled reconciliation job retries DCC automatically.
// This keeps the pipeline non-blocking under burst traffic (e.g. during
// a Janmashtami campaign where hundreds of payments complete in a short
// window) — a slow DCC response never delays the WhatsApp receipt for a
// different donor whose payment completed at the same time.
async function runPostCompletionPipeline(donationId, paymentId) {
  let donation;
  try {
    donation = await donationModel.findById(donationId);
    if (!donation) return;
  } catch (err) {
    console.error("Post-completion pipeline: failed to load donation", String(donationId), err && err.message ? err.message : err);
    return;
  }

  // DCC sync — fire-and-forget, failures visible in Needs Manual Receipt tab.
  syncDonationToDcc(donation, paymentId).catch((err) => {
    console.error("DCC sync failed (non-fatal, will appear in Needs Manual Receipt):", String(donationId), err && err.message ? err.message : err);
  });

  // WhatsApp receipt — fire-and-forget after refreshing the donation so
  // we have the DCC receipt number if it synced fast enough, otherwise
  // the idempotency guard and the Needs WhatsApp tab handle the retry.
  setImmediate(async () => {
    try {
      const refreshed = await donationModel.findById(donationId);
      if (refreshed) await sendDonationWhatsAppReceipt(refreshed);
    } catch (err) {
      console.error("WhatsApp receipt failed (non-fatal, will appear in Needs WhatsApp tab):", String(donationId), err && err.message ? err.message : err);
    }
  });

  // Meta CAPI — best-effort, never blocks anything.
  try {
    const { sendPurchaseEvent } = require("./metaCapi.service");
    sendPurchaseEvent(donation).catch((e) => {
      console.warn("Meta CAPI purchase event failed (non-fatal):", e && e.message ? e.message : e);
    });
  } catch (e) {
    console.warn("Meta CAPI import failed (non-fatal):", e && e.message ? e.message : e);
  }
}

// Full synchronous flow: mark completed + run pipeline.
// Used by webhooks and reconciliation where no user is waiting.
async function completeDonation({ donationId, orderId, paymentId }) {
  const donation = await markDonationCompleted({ donationId, orderId, paymentId });
  if (!donation) return null;

  await runPostCompletionPipeline(donation._id, paymentId);

  return donationModel.findById(donation._id);
}

// Handles a Razorpay `subscription.charged` event — fires for EVERY charge
// on a subscription, including the very first one. Shared by both the
// inline webhook fallback (payment.controller.js, used when Redis isn't
// available) and the queued worker (worker/paymentWorker.js) so the two
// paths can never drift apart with different logic for the same event.
//
// Two cases:
//   - First charge: the donor's authorization already created a pending
//     donation record (in createSubscription). If it's still pending here
//     (verifyPayment from the frontend hasn't completed it yet, or never
//     will if the donor closed the tab right after authorizing), complete
//     THAT record rather than creating a duplicate.
//   - Every later monthly charge: clone the original into a fresh record
//     (all receipt/DCC/WhatsApp/payment-identifier fields stripped so it
//     starts clean) and complete that.
// Idempotent against duplicate webhook delivery via razorpayPaymentId.
async function handleSubscriptionCharged(payload) {
  const payment = payload && payload.payment && payload.payment.entity;
  const subscription = payload && payload.subscription && payload.subscription.entity;
  const subId = (subscription && subscription.id) || (payment && payment.subscription_id);
  if (!payment || !subId) return { ok: false, reason: "missing_payment_or_subscription" };

  const already = await donationModel.findOne({ razorpayPaymentId: payment.id });
  if (already) {
    return { ok: true, skipped: true, reason: "already_recorded" };
  }

  const original = await donationModel.findOne({ subscriptionId: subId }).sort({ createdAt: 1 });
  if (!original) {
    return { ok: false, reason: "no_original_donation_found" };
  }

  let targetDonationId;
  if (original.status === "pending") {
    // First charge — complete the record created at signup rather than
    // creating a duplicate.
    targetDonationId = original._id;
  } else {
    // A later monthly charge — clone the original into a fresh record.
    const src = original.toObject();
    [
      "_id", "__v", "createdAt", "updatedAt", "date",
      "razorpayOrderId", "razorpayPaymentId", "transactionId",
      "receiptNumber", "receiptGeneratedAt",
      "lastPaymentDate",
      "dccSyncedAt", "dccLastAttemptAt", "dccSyncError", "dccPayload", "dccResponse", "dccSyncStatus",
      "whatsappReceiptSentAt", "whatsappReceiptError", "whatsappSendStatus",
    ].forEach((k) => delete src[k]);
    const clone = await donationModel.create({
      ...src,
      amount: payment.amount ? payment.amount / 100 : original.amount,
      status: "pending",
    });
    targetDonationId = clone._id;
  }

  await completeDonation({ donationId: targetDonationId, paymentId: payment.id });
  await donationModel.findByIdAndUpdate(original._id, { lastPaymentDate: new Date() });

  return { ok: true, donationId: targetDonationId.toString() };
}

module.exports = { completeDonation, markDonationCompleted, runPostCompletionPipeline, sendDonationWhatsAppReceipt, handleSubscriptionCharged };
