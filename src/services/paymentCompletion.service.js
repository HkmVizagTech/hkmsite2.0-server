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
async function sendDonationWhatsAppReceipt(donation) {
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
    });
    return { ok: true, withPdf: true };
  } catch (error) {
    // PDF generation or the WhatsApp send itself failed -- still no
    // message goes out (per policy), just record why for admin visibility.
    const message = error && error.message ? error.message : String(error);
    console.error("WhatsApp PDF receipt failed for donation", donation._id.toString(), message);
    await donationModel.findByIdAndUpdate(donation._id, { whatsappReceiptError: message });
    return { ok: false, error: message };
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
}

async function completeDonation({ donationId, orderId, paymentId }) {
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

  await syncDonationToDcc(donation, paymentId);

  // Re-fetch: syncDonationToDcc just updated receiptNumber/dccSyncStatus in
  // the DB, but the in-memory `donation` object above is from before that
  // — without this, the WhatsApp step below would never see a completed
  // DCC sync and would always fall back to the "processing" text template.
  donation = await donationModel.findById(donation._id);

  // Isolated: WhatsApp failure must never throw here or alter what's
  // returned to the caller (the webhook/verify response already succeeded).
  await sendDonationWhatsAppReceipt(donation);

  return donation;
}

module.exports = { completeDonation, sendDonationWhatsAppReceipt };
