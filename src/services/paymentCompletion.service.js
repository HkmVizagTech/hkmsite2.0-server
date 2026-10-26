import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tx } from "../db/pg.js";
import { donations, claimUpdate, mongoLimit, dbDateBound } from "../domain/donationDb.js";
import { castPaymentDonationId } from "../domain/paymentCast.js";
import { syncDonationToDcc } from "./dcc.service.js";
import { isWhatsAppConfigured, sendTemplateMessage, sendTemplateMessageWithAttachment } from "./whatsapp.service.js";
import { isGupshupReceiptConfigured, sendReceiptWhatsappViaGupshup } from "./gupshup.service.js";
import { generateReceiptBuffer } from "./receipt.service.js";
import { cacheDel, cacheKeys } from "../cache/memoryCache.js";
import { findOrCreateDonor } from "./donor.service.js";
import { sendPurchaseEvent } from "./metaCapi.service.js";
import { notifyDrmOfDonation } from "./drmNotify.service.js";

const RECEIPT_TEMPLATE_NAME = process.env.WAPI_RECEIPT_TEMPLATE_NAME || "common_donation_success_reciept";

const DEFAULT_RECEIPT_PROVIDER = () => String(process.env.RECEIPT_WHATSAPP_PROVIDER || "gupshup").toLowerCase();

const FLAXXA_SOURCE_PAGES = new Set(
  String(process.env.RECEIPT_FLAXXA_SOURCE_PAGES || "donations")
    .split(",")
    .map((p) =>
      p
        .trim()
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase()
    )
    .filter(Boolean)
);

// Same normalisation the pending-reminder service uses, so "/donations" and
// "/donations/c/ravi" both resolve to "donations".
const baseSourcePage = (sourcePage) =>
  String(sourcePage || "")
    .replace(/^\/+/, "")
    .replace(/\/c\/[^/]+$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

const RECEIPT_PROVIDER = (donation) => {
  const page = baseSourcePage(donation && donation.sourcePage);
  if (page && FLAXXA_SOURCE_PAGES.has(page)) return "flaxxa";
  return DEFAULT_RECEIPT_PROVIDER();
};

const THANKYOU_TEMPLATE_NAME = process.env.WAPI_THANKYOU_TEMPLATE_NAME || "regular_donation_success_message";
const THANKYOU_ENABLED = () => String(process.env.DONATION_THANKYOU_ENABLED || "true") !== "false";

async function sendDonationWhatsAppReceipt(donation, { force = false } = {}) {
  const provider = RECEIPT_PROVIDER(donation);
  const configured = provider === "gupshup" ? isGupshupReceiptConfigured() : isWhatsAppConfigured();
  if (!configured) {
    return { ok: false, skipped: true, reason: "whatsapp_not_configured", provider };
  }
  if (!donation.donorMobile) return { ok: false, skipped: true, reason: "no_phone_number" };

  if (!donation.receiptNumber) {
    if (!THANKYOU_ENABLED() || donation.whatsappThankYouSentAt) {
      return { ok: false, skipped: true, reason: "no_receipt_yet" };
    }

    // The acknowledgement template lives in Flaxxa, so it always goes from
    // that number regardless of which provider owns this page's receipt.
    if (!isWhatsAppConfigured()) {
      return { ok: false, skipped: true, reason: "no_receipt_yet" };
    }

    // Claim it before sending, so two pipeline runs racing each other cannot
    // both get past the check above.
    const claimed = await claimUpdate(
      { _id: donation._id, whatsappThankYouSentAt: null },
      { whatsappThankYouSentAt: new Date() }
    );
    if (!claimed) return { ok: false, skipped: true, reason: "no_receipt_yet" };

    const ackName = donation.donorName || "Donor";
    const ackAmount = Number(donation.amount || 0).toLocaleString("en-IN");
    const ackSeva = donation.sevaName || donation.type || "Seva";
    try {
      await sendTemplateMessage(donation.donorMobile, THANKYOU_TEMPLATE_NAME, [
        { type: "text", text: ackName }, // {{1}} donor name
        { type: "text", text: ackAmount }, // {{2}} amount
        { type: "text", text: ackSeva }, // {{3}} seva, in "support towards"
        { type: "text", text: ackSeva }, // {{4}} seva, in "is a sacred service"
      ]);
      return { ok: true, thankYouOnly: true, reason: "no_receipt_yet", provider: "flaxxa" };
    } catch (err) {
      // Release the claim so a later pipeline run (or the admin resend) can
      // try again — a failed send must not look like a sent one.
      await donations.updateById(donation._id, { whatsappThankYouSentAt: null });
      const msg = err && err.message ? err.message : String(err);
      console.error("Thank-you acknowledgement failed for donation", String(donation._id), msg);
      return { ok: false, skipped: true, reason: "no_receipt_yet", thankYouError: msg };
    }
  }

  if (!force && donation.whatsappReceiptSentAt) {
    return { ok: true, skipped: true, reason: "already_sent" };
  }

  const lockQuery = { _id: donation._id, whatsappSendStatus: { $ne: "sending" } };
  if (!force) lockQuery.whatsappReceiptSentAt = null;

  const lock = await claimUpdate(lockQuery, { whatsappSendStatus: "sending" });
  if (!lock) {
    if (!force) {
      const latest = await donations.findById(donation._id);
      if (latest?.whatsappReceiptSentAt) return { ok: true, skipped: true, reason: "already_sent" };
    }
    return { ok: false, skipped: true, reason: "send_in_progress" };
  }

  // Bare number: both approved templates print the currency symbol and "/-"
  // themselves, so "2,500" here becomes "₹2,500/-" in the delivered message.
  const amountText = Number(donation.amount || 0).toLocaleString("en-IN");
  const donorName = donation.donorName || "Donor";
  const sevaText = donation.sevaName || donation.type || "Seva";
  const filename = `Donation_Receipt_${String(donation.donorName || "Donor").replace(/\s+/g, "_")}.pdf`;

  let tmpFile = null;
  try {
    const pdfBytes = await generateReceiptBuffer(donation._id);

    let sendResult = null;

    if (provider === "gupshup") {
      // Gupshup attaches the PDF from a public link (uploaded to R2 inside
      // this call) rather than as multipart binary.
      sendResult = await sendReceiptWhatsappViaGupshup({
        phone: donation.donorMobile,
        donorName,
        amountText,
        sevaName: sevaText,
        pdfBytes,
        filename,
        donationId: donation._id.toString(),
      });
    } else {
      tmpFile = path.join(os.tmpdir(), `receipt-${donation._id}-${Date.now()}.pdf`);
      fs.writeFileSync(tmpFile, pdfBytes);

      sendResult = await sendTemplateMessageWithAttachment(
        donation.donorMobile,
        RECEIPT_TEMPLATE_NAME,
        [
          { type: "text", text: donorName },
          { type: "text", text: amountText },
          { type: "text", text: sevaText },
        ],
        tmpFile,
        filename
      );
    }

    const messageId = (sendResult && (sendResult.messageId || sendResult.message_wamid || sendResult.wamid)) || null;

    await donations.updateById(donation._id, {
      whatsappReceiptSentAt: new Date(),
      whatsappReceiptError: null,
      whatsappSendStatus: null,
      whatsappProvider: provider,
      whatsappMessageId: messageId,
      whatsappDeliveryStatus: "submitted",
      whatsappDeliveredAt: null,
    });
    return { ok: true, withPdf: true, provider, messageId };
  } catch (error) {
    // PDF generation or the WhatsApp send itself failed -- still no
    // message goes out (per policy), just record why for admin visibility.
    const message = error && error.message ? error.message : String(error);
    console.error(`WhatsApp PDF receipt failed via ${provider} for donation`, donation._id.toString(), message);
    await donations.updateById(donation._id, { whatsappReceiptError: message, whatsappSendStatus: null });
    return { ok: false, error: message };
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  }
}

async function resendRecentFailedReceipts({ hours = 9, limit = 100, dryRun = false, delayMs = 1200 } = {}) {
  const useWindow = Number(hours) > 0;
  const since = useWindow ? new Date(Date.now() - Number(hours) * 60 * 60 * 1000) : null;

  // Everything that has a real receipt and no recorded WhatsApp send.
  const base = {
    status: "completed",
    receiptNumber: { $nin: [null, ""] },
    whatsappReceiptSentAt: null,
  };
  // ...of which only these can actually be messaged.
  const sendable = { ...base, donorMobile: { $nin: [null, ""] } };
  const query = useWindow ? { ...sendable, createdAt: { $gte: dbDateBound(since) } } : sendable;

  const [totalMatching, allTimeSendable, allTimeNeeding] = await Promise.all([
    donations.count(query),
    donations.count(sendable),
    donations.count(base),
  ]);

  const candidates = await donations.find(query, {
    sort: { createdAt: 1, _id: 1 },
    limit: mongoLimit(limit),
    fields: [
      "donorName",
      "donorMobile",
      "amount",
      "sevaName",
      "type",
      "receiptNumber",
      "createdAt",
      "whatsappReceiptError",
    ],
  });

  const summary = {
    provider: RECEIPT_PROVIDER(),
    windowHours: useWindow ? Number(hours) : null,
    since: since ? since.toISOString() : null,
    totalMatching,
    allTimeSendable,
    allTimeNoPhone: Math.max(0, allTimeNeeding - allTimeSendable),
    candidates: candidates.length,
    remaining: Math.max(0, totalMatching - candidates.length),
    sent: 0,
    skipped: 0,
    failed: 0,
    dryRun: Boolean(dryRun),
    results: [],
  };

  if (dryRun) {
    summary.results = candidates.map((d) => ({
      id: d._id.toString(),
      donor: d.donorName,
      amount: d.amount,
      receiptNumber: d.receiptNumber,
      createdAt: d.createdAt,
      previousError: d.whatsappReceiptError || null,
    }));
    return summary;
  }

  for (const donation of candidates) {
    try {
      const result = await sendDonationWhatsAppReceipt(donation);
      if (result.ok && !result.skipped) summary.sent += 1;
      else if (result.skipped) summary.skipped += 1;
      else summary.failed += 1;

      summary.results.push({
        id: donation._id.toString(),
        donor: donation.donorName,
        ok: Boolean(result.ok),
        skipped: Boolean(result.skipped),
        reason: result.reason || null,
        error: result.error || null,
        messageId: result.messageId || null,
      });
    } catch (err) {
      summary.failed += 1;
      summary.results.push({
        id: donation._id.toString(),
        donor: donation.donorName,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }

    if (delayMs) await new Promise((r) => setTimeout(r, Number(delayMs)));
  }

  return summary;
}

// Fast path: marks the donation as completed and sets payment IDs.
// Returns the donation document (or null if not found).
async function markDonationCompleted({ donationId, orderId, paymentId }) {
  // With no donation id the old code matched `razorpayOrderId: undefined`, i.e. the first donation with no order id.
  const query = donationId ? { _id: castPaymentDonationId(donationId) } : { razorpayOrderId: orderId ?? null };

  let donation = await claimUpdate(
    { ...query, status: { $ne: "completed" } },
    {
      status: "completed",
      ...(paymentId
        ? {
            razorpayPaymentId: paymentId,
            transactionId: paymentId,
          }
        : {}),
    }
  );

  if (!donation) {
    donation = await donations.findOne(query, { sort: { createdAt: 1, _id: 1 } });
  }

  if (!donation) return null;

  if (paymentId && (!donation.razorpayPaymentId || !donation.transactionId)) {
    donation = await donations.updateById(donation._id, {
      razorpayPaymentId: paymentId,
      transactionId: paymentId,
    });
  }

  return donation;
}

async function invalidateDonationCaches(donation) {
  if (!donation) return;
  try {
    await cacheDel(
      // Site-wide totals always move.
      cacheKeys.statsOverview(),
      cacheKeys.statsSqft(),
      // The per-seva donor wall is keyed by whichever of these the caller
      // queried by, so drop both spellings.
      donation.sevaName ? cacheKeys.statsSeva(donation.sevaName) : null,
      donation.type ? cacheKeys.statsCategory(donation.type) : null,
      // P2P campaign page, when this donation came through one.
      donation.campaignerSlug ? cacheKeys.campaigner(donation.campaignerSlug) : null
    );
  } catch (err) {
    // cacheDel cannot fail in practice; this is belt-and-braces so a
    // cache concern can never surface as a failed donation.
    console.warn(
      "Cache invalidation after donation completion failed (non-fatal):",
      err && err.message ? err.message : err
    );
  }
}

async function runPostCompletionPipeline(donationId, paymentId, { sendWhatsApp = true } = {}) {
  let donation;
  try {
    donation = await donations.findById(donationId);
    if (!donation) return;
  } catch (err) {
    console.error(
      "Post-completion pipeline: failed to load donation",
      String(donationId),
      err && err.message ? err.message : err
    );
    return;
  }

  invalidateDonationCaches(donation);

  if (donation.donorMobile && !donation.donorRecordId) {
    try {
      const donorRecord = await findOrCreateDonor({
        mobile: donation.donorMobile,
        name: donation.donorName,
        email: donation.donorEmail,
      });
      await donations.updateById(donation._id, { donorRecordId: donorRecord._id, donorId: donorRecord.donorId });
    } catch (err) {
      console.error(
        "Donor record linking failed (non-fatal):",
        String(donationId),
        err && err.message ? err.message : err
      );
    }
  }

  try {
    await syncDonationToDcc(donation, paymentId);
  } catch (err) {
    console.error(
      "DCC sync failed (non-fatal, will appear in Needs Manual Receipt tab):",
      String(donationId),
      err && err.message ? err.message : err
    );
  }

  try {
    const refreshed = sendWhatsApp ? await donations.findById(donationId) : null;
    if (refreshed) await sendDonationWhatsAppReceipt(refreshed);
  } catch (err) {
    console.error(
      "WhatsApp receipt failed (non-fatal, will appear in Needs WhatsApp tab):",
      String(donationId),
      err && err.message ? err.message : err
    );
  }

  // Meta CAPI — best-effort, never blocks anything.
  try {
    sendPurchaseEvent(donation).catch((e) => {
      console.warn("Meta CAPI purchase event failed (non-fatal):", e && e.message ? e.message : e);
    });
  } catch (e) {
    console.warn("Meta CAPI import failed (non-fatal):", e && e.message ? e.message : e);
  }

  try {
    notifyDrmOfDonation(donationId).catch((e) => {
      console.warn("DRM push failed (non-fatal):", e && e.message ? e.message : e);
    });
  } catch (e) {
    console.warn("DRM push import failed (non-fatal):", e && e.message ? e.message : e);
  }
}

// Full synchronous flow: mark completed + run pipeline.
// Used by webhooks and reconciliation where no user is waiting.
async function completeDonation({ donationId, orderId, paymentId, sendWhatsApp = true }) {
  const donation = await markDonationCompleted({ donationId, orderId, paymentId });
  if (!donation) return null;

  await runPostCompletionPipeline(donation._id, paymentId, { sendWhatsApp });

  return donations.findById(donation._id);
}

async function handleSubscriptionCharged(payload) {
  const payment = payload && payload.payment && payload.payment.entity;
  const subscription = payload && payload.subscription && payload.subscription.entity;
  const subId = (subscription && subscription.id) || (payment && payment.subscription_id);
  if (!payment || !subId) return { ok: false, reason: "missing_payment_or_subscription" };

  const prepared = await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`subcharge:${payment.id}`]);

    const already = await donations.findOne({ razorpayPaymentId: payment.id }, { client });
    if (already) return { early: { ok: true, skipped: true, reason: "already_recorded" } };

    const original = await donations.findOne({ subscriptionId: subId }, { sort: { createdAt: 1, _id: 1 }, client });
    if (!original) return { early: { ok: false, reason: "no_original_donation_found" } };

    // The sign-up record was never paid: still pending, "active" (mandate approved - subscription.activated),
    // or closed as failed ("never paid") by the reconcile job before this first charge arrived.
    const neverPaid =
      !original.razorpayPaymentId &&
      (original.status === "pending" ||
        original.status === "active" ||
        (original.status === "failed" && original.closedAsNotPaidAt));
    if (neverPaid) {
      // First charge — complete the record created at signup rather than
      // creating a duplicate.
      return { original, targetDonationId: original._id };
    }

    // A later monthly charge — clone the original into a fresh record
    // (all receipt/DCC/WhatsApp/payment-identifier fields stripped).
    const src = { ...original };
    [
      "_id",
      "__v",
      "createdAt",
      "updatedAt",
      "date",
      "razorpayOrderId",
      "razorpayPaymentId",
      "transactionId",
      "receiptNumber",
      "receiptGeneratedAt",
      "lastPaymentDate",
      "dccSyncedAt",
      "dccLastAttemptAt",
      "dccSyncError",
      "dccPayload",
      "dccResponse",
      "dccSyncStatus",
      "dccAttempts",
      "dccRecoveredAt",
      "whatsappReceiptSentAt",
      "whatsappReceiptError",
      "whatsappSendStatus",
      "whatsappThankYouSentAt",
      "whatsappMessageId",
      "whatsappDeliveryStatus",
      "whatsappDeliveredAt",
      "whatsappProvider",
      "whatsappPendingReminderSent",
      "whatsappPendingReminderAttempts",
      "whatsappPendingReminderError",
      "metaPurchaseSentAt",
      "paymentError",
      "failedAttempts",
      "closedAsNotPaidAt",
      "lastReconcileCheckAt",
    ].forEach((k) => delete src[k]);
    const clone = await donations.insert(
      {
        ...src,
        amount: payment.amount ? payment.amount / 100 : original.amount,
        status: "pending",
        razorpayPaymentId: payment.id,
        transactionId: payment.id,
      },
      { client }
    );
    return { original, targetDonationId: clone._id };
  });
  if (prepared.early) return prepared.early;
  const { original, targetDonationId } = prepared;

  await completeDonation({ donationId: targetDonationId, paymentId: payment.id });
  await donations.updateById(original._id, { lastPaymentDate: new Date() });

  return { ok: true, donationId: String(targetDonationId) };
}

export {
  completeDonation,
  markDonationCompleted,
  runPostCompletionPipeline,
  sendDonationWhatsAppReceipt,
  resendRecentFailedReceipts,
  handleSubscriptionCharged,
  invalidateDonationCaches,
};
