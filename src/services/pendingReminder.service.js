// src/services/pendingReminder.service.js
//
// Pending-transaction WhatsApp reminder — mirrors the flow already running
// on the Annadana/Subhojanam site (sendPendingWhatsappReminders script +
// /api/internal/send-pending-reminders endpoint), adapted for this site's
// donation model and many sevas.
//
// A donation becomes "pending" here when the Razorpay order is created but
// the payment is not yet captured/confirmed (abandoned checkout, or payment
// still in progress). Once a pending donation is older than the cutoff
// (default 6 minutes, like Annadan) and we haven't already messaged the
// donor, we send the approved "pending transaction" WhatsApp template with
// that donation's own seva name — so one template covers every seva.
//
// The whatsappPendingReminderSent flag makes this idempotent: it is set only
// after a successful send, so overlapping runs (in-process scheduler + an
// external cron hitting the internal endpoint) can never double-message.

const { donationModel } = require("../models/donation.model");
const {
  isWhatsAppConfigured,
  sendPendingWhatsapp,
} = require("./whatsapp.service");

// How old a pending donation must be before we nudge the donor (6 minutes —
// enough for UPI/auto-debit flows to settle or fail visibly, and for the
// donor to have genuinely abandoned an in-progress checkout).
const CUTOFF_MINUTES = Number(process.env.PENDING_REMINDER_CUTOFF_MINUTES || 6);

// Batch size per run — keeps each pass short and lets the schedule loop
// around to remaining records on later runs.
const BATCH_SIZE = Number(process.env.PENDING_REMINDER_BATCH_SIZE || 100);

/**
 * Finds pending donations that are old enough and un-reminded, sends each one
 * the pending-transaction WhatsApp message, and marks whatsappPendingReminderSent.
 *
 * Never throws for individual failures — a bad phone number or a Flaxxa error
 * on one donation must not stop the rest of the batch (same as Annadan).
 *
 * @returns {Promise<{skipped?: boolean, reason?: string, checked: number, sent: number, failed: number}>}
 */
async function runPendingReminders() {
  if (!isWhatsAppConfigured()) {
    return { skipped: true, reason: "whatsapp_not_configured", checked: 0, sent: 0, failed: 0 };
  }

  const cutoff = new Date(Date.now() - CUTOFF_MINUTES * 60 * 1000);

  const pendingDonations = await donationModel
    .find({
      status: "pending",
      createdAt: { $lte: cutoff },
      whatsappPendingReminderSent: { $ne: true },
      // Skip recurring/subscription first-charges — those stay "pending"
      // until the subscription activates, and the donor already authorised
      // autopay, so a "donation not confirmed" nudge would be wrong here.
      isRecurring: { $ne: true },
    })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE);

  let sent = 0;
  let failed = 0;

  for (const donation of pendingDonations) {
    if (!donation.donorMobile) {
      // No phone on record — nothing to message; mark it so we don't re-check
      // this record forever on every pass.
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      continue;
    }

    try {
      await sendPendingWhatsapp(
        donation.donorMobile,
        donation.donorName || "Devotee",
        donation.amount,
        donation.sevaName || donation.type || "your seva",
        donation.sourcePage,
      );
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      sent += 1;
      console.log(
        "Pending reminder sent for donation",
        String(donation._id),
        "->",
        donation.donorMobile,
      );
    } catch (err) {
      failed += 1;
      console.error(
        "Pending reminder failed for donation",
        String(donation._id),
        err && err.response && err.response.data
          ? JSON.stringify(err.response.data)
          : (err && err.message ? err.message : err),
      );
    }
  }

  return {
    checked: pendingDonations.length,
    sent,
    failed,
    cutoffMinutes: CUTOFF_MINUTES,
  };
}

module.exports = { runPendingReminders };
