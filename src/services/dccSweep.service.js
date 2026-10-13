// Every successful donation must end up in DCC with a receipt number, and the
// donor must get that receipt on WhatsApp. The completion pipeline pushes each
// donation once; this sweep catches everything that push missed:
//
//   * DCC was down, slow, or answered "An error has occurred." — DCC often
//     saves the donation and then fails while emailing its own receipt, so the
//     receipt number never reaches us.
//   * the site restarted mid-push (a "syncing" lock left behind).
//   * a hand-entered donation whose push failed.
//
// Pushing again is safe because DCC de-duplicates on the transaction id (the
// Razorpay payment id / UTR) and answers a repeat push with the receipt it
// already issued. A donation WITHOUT a transaction id is pushed automatically
// only once: DCC cannot recognise it, so a second push would raise a second
// receipt — those wait in the admin panel for a person to check DCC.
//
// Donations from before the site started pushing to DCC (DCC_AUTO_SINCE,
// 2 July 2026) are never pushed automatically — staff may have entered them in
// DCC by hand. Admin can still push them one at a time.

const { donationModel } = require("../models/donation.model");
const { syncDonationToDcc, dccTransactionId, isDccConfigured } = require("./dcc.service");

const AUTO_SINCE = new Date(process.env.DCC_AUTO_SINCE || "2026-07-02T00:00:00+05:30");
const STALE_LOCK_MS = 10 * 60 * 1000; // a push never takes this long; the process died mid-push
const SETTLE_MS = 5 * 60 * 1000; // leave a just-completed donation to its own pipeline
const MAX_AUTO_ATTEMPTS = Number(process.env.DCC_MAX_AUTO_ATTEMPTS || 12);
// Wait before retry N (by attempts already made): 10 min, 30 min, 2 h, 6 h, then twice a day.
const BACKOFF_MINUTES = [0, 10, 30, 120, 360, 720];

const NO_RECEIPT = { status: "completed", receiptNumber: { $in: [null, ""] } };
const FIELDS =
  "donorName donorMobile amount sevaName type createdAt updatedAt manualEntry manualPaymentMode " +
  "razorpayPaymentId utrNumber transactionId dccSyncStatus dccSyncError dccLastAttemptAt dccAttempts";

const attemptsOf = (d) => Math.max(d.dccAttempts || 0, d.dccLastAttemptAt ? 1 : 0);

/**
 * Whether the sweep may push this donation now, and if not, why.
 * `now` is injectable for tests.
 */
function autoPushDecision(d, now = Date.now(), { ignoreBackoff = false } = {}) {
  if (d.dccSyncStatus === "syncing") return { push: false, reason: "pushing" };
  if (new Date(d.createdAt) < AUTO_SINCE) return { push: false, reason: "before_auto_since", admin: true };
  const attempts = attemptsOf(d);
  if (attempts > 0 && !dccTransactionId(d)) return { push: false, reason: "no_transaction_id", admin: true };
  if (attempts >= MAX_AUTO_ATTEMPTS) return { push: false, reason: "gave_up", admin: true };
  if (attempts === 0) {
    const settled = now - new Date(d.updatedAt || d.createdAt).getTime() >= SETTLE_MS;
    return settled ? { push: true } : { push: false, reason: "just_completed" };
  }
  if (ignoreBackoff) return { push: true }; // admin pressed "Push all now"
  const waitMin = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
  const due = new Date(d.dccLastAttemptAt).getTime() + waitMin * 60 * 1000;
  return now >= due ? { push: true } : { push: false, reason: "waiting_retry", nextAt: new Date(due) };
}

/** Frees "syncing" locks left by a push that never finished (deploy/restart mid-call). */
async function releaseStaleLocks() {
  const res = await donationModel.updateMany(
    { dccSyncStatus: "syncing", dccLastAttemptAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
    { dccSyncStatus: "failed", dccSyncError: "The push to DCC was interrupted (server restarted). It will be retried." }
  );
  return res.modifiedCount || 0;
}

/**
 * Pushes one donation to DCC and, once it has a receipt number, sends the
 * WhatsApp receipt (once — sendDonationWhatsAppReceipt never sends twice).
 */
async function pushAndSendReceipt(donationId, { sendReceipt = true } = {}) {
  const before = await donationModel.findById(donationId).select("receiptNumber manualEntry").lean();
  if (!before) return { ok: false, reason: "donation_not_found" };

  const dcc = before.receiptNumber ? { ok: true, skipped: true, reason: "already_synced" } : await syncDonationToDcc(donationId);
  const after = await donationModel.findById(donationId);
  const receiptNumber = after && after.receiptNumber ? after.receiptNumber : null;
  const result = { ok: Boolean(receiptNumber), receiptNumber, dcc, whatsapp: null };

  if (receiptNumber && !before.receiptNumber) {
    // New receipt: DRM shows receipts too. Hand-entered donations are told
    // by syncDonationToDcc itself.
    if (!before.manualEntry) {
      try {
        const { notifyDrmOfDonation } = require("./drmNotify.service");
        notifyDrmOfDonation(after._id, { reason: "receipt_issued" }).catch(() => undefined);
      } catch {}
    }
  }

  if (receiptNumber && sendReceipt && !after.whatsappReceiptSentAt) {
    try {
      const { sendDonationWhatsAppReceipt } = require("./paymentCompletion.service");
      result.whatsapp = await sendDonationWhatsAppReceipt(after);
    } catch (err) {
      result.whatsapp = { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
  return result;
}

/** One line for admin screens: what a push did. */
function pushResultMessage(result) {
  if (!result.receiptNumber) {
    return `DCC did not return a receipt number: ${(result.dcc && (result.dcc.error || result.dcc.reason)) || "unknown"}`;
  }
  const wa = result.whatsapp;
  const whatsapp = !wa || wa.reason === "already_sent"
    ? "WhatsApp receipt already sent earlier"
    : wa.ok && !wa.skipped
    ? "WhatsApp receipt sent"
    : `WhatsApp not sent (${wa.reason || wa.error || "unknown"})`;
  return `Receipt ${result.receiptNumber} — ${whatsapp}`;
}

/**
 * Admin typed in the receipt number from DCC: store it and send the WhatsApp
 * receipt (once). Returns null when the donation does not exist.
 */
async function setReceiptNumberAndSend(donationId, receiptNumber) {
  const donation = await donationModel.findByIdAndUpdate(
    donationId,
    { receiptNumber, receiptGeneratedAt: new Date(), dccSyncStatus: "synced", dccSyncedAt: new Date(), dccSyncError: null },
    { new: true }
  );
  if (!donation) return null;
  let whatsapp = null;
  if (donation.status === "completed" && !donation.whatsappReceiptSentAt) {
    try {
      const { sendDonationWhatsAppReceipt } = require("./paymentCompletion.service");
      whatsapp = await sendDonationWhatsAppReceipt(donation);
    } catch (e) {
      whatsapp = { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  const sent = whatsapp && whatsapp.ok && !whatsapp.skipped;
  const message = `Receipt number set to ${receiptNumber}` +
    (sent ? " — WhatsApp receipt sent" : whatsapp ? ` — WhatsApp not sent (${whatsapp.reason || whatsapp.error || "unknown"})` : "");
  return { donation, whatsapp, message };
}

// `scope` (a donation filter) limits a sweep or the status list to one part
// of the site — the /donations page admin passes its page filter.
const scoped = (query, scope) => (scope ? { $and: [query, scope] } : query);

let running = false;

/**
 * One pass: push every due donation that has no receipt number.
 * `limit` caps pushes per pass (DCC is slow; the next pass continues).
 */
async function sweepDccReceipts({ limit = 25, now = Date.now(), ignoreBackoff = false, scope = null } = {}) {
  const summary = { checked: 0, pushed: 0, receipts: 0, recovered: 0, whatsappSent: 0, failed: 0, staleLocks: 0, skipped: {} };
  if (!isDccConfigured()) return { ...summary, skippedAll: "dcc_not_configured" };
  if (running) return { ...summary, skippedAll: "already_running" };
  running = true;
  try {
    summary.staleLocks = await releaseStaleLocks();
    const candidates = await donationModel.find(scoped(NO_RECEIPT, scope)).sort({ createdAt: -1 }).limit(2000).select(FIELDS).lean();
    summary.checked = candidates.length;

    for (const d of candidates) {
      if (summary.pushed >= limit) break;
      const decision = autoPushDecision(d, now, { ignoreBackoff });
      if (!decision.push) {
        summary.skipped[decision.reason] = (summary.skipped[decision.reason] || 0) + 1;
        continue;
      }
      summary.pushed += 1;
      const r = await pushAndSendReceipt(d._id);
      if (r.receiptNumber) {
        summary.receipts += 1;
        if (r.dcc && r.dcc.dccResponse && /already exists/i.test(String(r.dcc.dccResponse.Message || ""))) summary.recovered += 1;
      } else summary.failed += 1;
      if (r.whatsapp && r.whatsapp.ok && !r.whatsapp.skipped) summary.whatsappSent += 1;
    }
    return summary;
  } finally {
    running = false;
  }
}

/** Counts and the list behind Admin → Donations → DCC receipts. */
// Donations from before AUTO_SINCE are only counted, not listed, unless asked
// for: years of history without a site-side receipt would bury the live list.
async function dccReceiptStatus({ listLimit = 300, includeOld = false, scope = null } = {}) {
  const now = Date.now();
  const query = includeOld ? NO_RECEIPT : { ...NO_RECEIPT, createdAt: { $gte: AUTO_SINCE } };
  const [missing, beforeAutoSince] = await Promise.all([
    donationModel.find(scoped(query, scope)).sort({ createdAt: -1 }).limit(2000).select(FIELDS).lean(),
    donationModel.countDocuments(scoped({ ...NO_RECEIPT, createdAt: { $lt: AUTO_SINCE } }, scope)),
  ]);

  const counts = { missing: missing.length, autoQueued: 0, retrying: 0, needsAdmin: 0, pushing: 0, beforeAutoSince };
  const rows = missing.map((d) => {
    const decision = autoPushDecision(d, now);
    let state;
    if (decision.reason === "pushing") state = "pushing";
    else if (decision.admin) state = "needs_admin";
    else if (attemptsOf(d) === 0) state = "queued";
    else state = "retrying";
    if (state === "pushing") counts.pushing += 1;
    else if (state === "needs_admin") counts.needsAdmin += 1;
    else if (state === "queued") counts.autoQueued += 1;
    else counts.retrying += 1;
    return {
      _id: d._id,
      donorName: d.donorName,
      donorMobile: d.donorMobile,
      amount: d.amount,
      sevaName: d.sevaName || d.type,
      createdAt: d.createdAt,
      manualEntry: !!d.manualEntry,
      transactionId: dccTransactionId(d),
      attempts: attemptsOf(d),
      lastAttemptAt: d.dccLastAttemptAt || null,
      lastError: d.dccSyncError || null,
      state,
      reason: decision.reason || null,
      nextAttemptAt: decision.nextAt || null,
    };
  });

  const [receiptNoWhatsapp, recovered7d] = await Promise.all([
    donationModel.countDocuments(scoped({
      status: "completed",
      receiptNumber: { $nin: [null, ""] },
      whatsappReceiptSentAt: { $in: [null, undefined] },
      donorMobile: { $nin: [null, ""] },
      createdAt: { $gte: AUTO_SINCE },
    }, scope)),
    donationModel.countDocuments(scoped({ dccRecoveredAt: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } }, scope)),
  ]);

  return {
    autoSince: AUTO_SINCE,
    counts: { ...counts, receiptNoWhatsapp, recovered7d },
    donations: rows.slice(0, listLimit),
  };
}

const isSweepRunning = () => running;

module.exports = {
  sweepDccReceipts,
  pushAndSendReceipt,
  pushResultMessage,
  setReceiptNumberAndSend,
  dccReceiptStatus,
  autoPushDecision,
  releaseStaleLocks,
  isSweepRunning,
  AUTO_SINCE,
};
