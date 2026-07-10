const fs = require("fs");
const os = require("os");
const path = require("path");
const { donationModel } = require("../models/donation.model");
const { syncDonationToDcc } = require("./dcc.service");
const {
  isWhatsAppConfigured,
  sendTemplateMessage,
  sendTemplateMessageWithAttachment,
} = require("./whatsapp.service");
const { generateReceiptBuffer } = require("./receipt.service");

// Approved Meta template names — set these once you've created/approved
// them via Meta Business Manager (through Flaxxa). Until WAPI_TOKEN is set,
// this whole step is skipped silently — never blocks or breaks the donation
// flow either way.
//  - RECEIPT template: has a document/media header placeholder, used once
//    DCC has returned a receiptNumber and the PDF has been generated.
//  - PENDING template: plain text only, used as an immediate fallback when
//    DCC hasn't returned a receipt yet (or isn't configured at all) so the
//    donor still gets a prompt thank-you instead of silence.
const RECEIPT_TEMPLATE_NAME = process.env.WAPI_RECEIPT_TEMPLATE_NAME || "donation_receipt_pdf";
const PENDING_TEMPLATE_NAME = process.env.WAPI_DONATION_TEMPLATE_NAME || "donation_receipt";

// Isolated on purpose: a WhatsApp failure (bad template name, Meta outage,
// invalid phone) must NEVER undo or break the donation record — the payment
// already succeeded and DCC (if configured) already has its own record.
// This mirrors the fix applied in subhojanam-server, where DCC, receipt
// generation, and WhatsApp send are each wrapped separately so one failing
// doesn't cascade into losing the others.
async function sendDonationWhatsAppReceipt(donation) {
  if (!isWhatsAppConfigured()) return { ok: false, skipped: true, reason: "whatsapp_not_configured" };
  if (!donation.donorMobile) return { ok: false, skipped: true, reason: "no_phone_number" };

  const amountText = `Rs. ${Number(donation.amount || 0).toLocaleString("en-IN")}`;

  // Path 1: DCC has already returned a receipt number — generate the PDF
  // and send it as the template's attachment.
  if (donation.receiptNumber) {
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
          { type: "text", text: amountText },
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
      // PDF/attachment path failed — fall through to the plain text
      // template below instead of giving up, so the donor still hears
      // something. Log the specific PDF failure for diagnosis.
      const message = error && error.message ? error.message : String(error);
      console.error("WhatsApp PDF receipt failed for donation", donation._id.toString(), message);
      await donationModel.findByIdAndUpdate(donation._id, { whatsappReceiptError: message });
    } finally {
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
  }

  // Path 2 (fallback): no receipt number yet, or the PDF path failed —
  // send a plain text thank-you so the donor isn't left with silence.
  try {
    const receiptText = donation.receiptNumber || "Processing";

    await sendTemplateMessage(donation.donorMobile, PENDING_TEMPLATE_NAME, [
      {
        type: "body",
        parameters: [
          { type: "text", text: donation.donorName || "Devotee" },
          { type: "text", text: amountText },
          { type: "text", text: donation.sevaName || "Seva" },
          { type: "text", text: receiptText },
        ],
      },
    ]);

    await donationModel.findByIdAndUpdate(donation._id, {
      whatsappReceiptSentAt: new Date(),
      whatsappReceiptError: null,
    });
    return { ok: true, withPdf: false };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error("WhatsApp receipt send failed for donation", donation._id.toString(), message);
    await donationModel.findByIdAndUpdate(donation._id, { whatsappReceiptError: message });
    return { ok: false, error: message };
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
