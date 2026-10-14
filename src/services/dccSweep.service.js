import { donations, normalizeFilter } from "../domain/donationDb.js";
import { castPaymentDonationId } from "../domain/paymentCast.js";
import { syncDonationToDcc, dccTransactionId, isDccConfigured } from "./dcc.service.js";
import { notifyDrmOfDonation } from "./drmNotify.service.js";
import { sendDonationWhatsAppReceipt } from "./paymentCompletion.service.js";

const AUTO_SINCE = new Date(process.env.DCC_AUTO_SINCE || "2026-07-02T00:00:00+05:30");
const STALE_LOCK_MS = 10 * 60 * 1000; // a push never takes this long; the process died mid-push
const SETTLE_MS = 5 * 60 * 1000; // leave a just-completed donation to its own pipeline
const MAX_AUTO_ATTEMPTS = Number(process.env.DCC_MAX_AUTO_ATTEMPTS || 12);
// Wait before retry N (by attempts already made): 10 min, 30 min, 2 h, 6 h, then twice a day.
const BACKOFF_MINUTES = [0, 10, 30, 120, 360, 720];

const NO_RECEIPT = { status: "completed", receiptNumber: { $in: [null, ""] } };
const FIELDS = [
  "donorName",
  "donorMobile",
  "amount",
  "sevaName",
  "type",
  "createdAt",
  "updatedAt",
  "manualEntry",
  "manualPaymentMode",
  "razorpayPaymentId",
  "utrNumber",
  "transactionId",
  "dccSyncStatus",
  "dccSyncError",
  "dccLastAttemptAt",
  "dccAttempts",
];

const attemptsOf = (d) => Math.max(d.dccAttempts || 0, d.dccLastAttemptAt ? 1 : 0);

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
  return donations.updateMany(
    { dccSyncStatus: "syncing", dccLastAttemptAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
    { dccSyncStatus: "failed", dccSyncError: "The push to DCC was interrupted (server restarted). It will be retried." }
  );
}

async function pushAndSendReceipt(donationId, { sendReceipt = true } = {}) {
  const before = await donations.findById(castPaymentDonationId(donationId), {
    fields: ["receiptNumber", "manualEntry"],
    lean: true,
  });
  if (!before) return { ok: false, reason: "donation_not_found" };

  const dcc = before.receiptNumber
    ? { ok: true, skipped: true, reason: "already_synced" }
    : await syncDonationToDcc(donationId);
  const after = await donations.findById(donationId);
  const receiptNumber = after && after.receiptNumber ? after.receiptNumber : null;
  const result = { ok: Boolean(receiptNumber), receiptNumber, dcc, whatsapp: null };

  if (receiptNumber && !before.receiptNumber) {
    // New receipt: DRM shows receipts too. Hand-entered donations are told
    // by syncDonationToDcc itself.
    if (!before.manualEntry) {
      try {
        notifyDrmOfDonation(after._id, { reason: "receipt_issued" }).catch(() => undefined);
      } catch {}
    }
  }

  if (receiptNumber && sendReceipt && !after.whatsappReceiptSentAt) {
    try {
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
  const whatsapp =
    !wa || wa.reason === "already_sent"
      ? "WhatsApp receipt already sent earlier"
      : wa.ok && !wa.skipped
        ? "WhatsApp receipt sent"
        : `WhatsApp not sent (${wa.reason || wa.error || "unknown"})`;
  return `Receipt ${result.receiptNumber} — ${whatsapp}`;
}

async function setReceiptNumberAndSend(donationId, receiptNumber) {
  const donation = await donations.updateById(castPaymentDonationId(donationId), {
    receiptNumber,
    receiptGeneratedAt: new Date(),
    dccSyncStatus: "synced",
    dccSyncedAt: new Date(),
    dccSyncError: null,
  });
  if (!donation) return null;
  let whatsapp = null;
  if (donation.status === "completed" && !donation.whatsappReceiptSentAt) {
    try {
      whatsapp = await sendDonationWhatsAppReceipt(donation);
    } catch (e) {
      whatsapp = { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  const sent = whatsapp && whatsapp.ok && !whatsapp.skipped;
  const message =
    `Receipt number set to ${receiptNumber}` +
    (sent
      ? " — WhatsApp receipt sent"
      : whatsapp
        ? ` — WhatsApp not sent (${whatsapp.reason || whatsapp.error || "unknown"})`
        : "");
  return { donation, whatsapp, message };
}

// `scope` (a donation filter) limits a sweep or the status list to one part
// of the site — the /donations page admin passes its page filter.
const scoped = (query, scope) => (scope ? { $and: [query, normalizeFilter(scope)] } : query);

let running = false;

async function sweepDccReceipts({ limit = 25, now = Date.now(), ignoreBackoff = false, scope = null } = {}) {
  const summary = {
    checked: 0,
    pushed: 0,
    receipts: 0,
    recovered: 0,
    whatsappSent: 0,
    failed: 0,
    staleLocks: 0,
    skipped: {},
  };
  if (!isDccConfigured()) return { ...summary, skippedAll: "dcc_not_configured" };
  if (running) return { ...summary, skippedAll: "already_running" };
  running = true;
  try {
    summary.staleLocks = await releaseStaleLocks();
    const candidates = await donations.find(scoped(NO_RECEIPT, scope), {
      sort: { createdAt: -1, _id: -1 },
      limit: 2000,
      fields: FIELDS,
      lean: true,
    });
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
        if (r.dcc && r.dcc.dccResponse && /already exists/i.test(String(r.dcc.dccResponse.Message || "")))
          summary.recovered += 1;
      } else summary.failed += 1;
      if (r.whatsapp && r.whatsapp.ok && !r.whatsapp.skipped) summary.whatsappSent += 1;
    }
    return summary;
  } finally {
    running = false;
  }
}

async function dccReceiptStatus({ listLimit = 300, includeOld = false, scope = null } = {}) {
  const now = Date.now();
  const query = includeOld ? NO_RECEIPT : { ...NO_RECEIPT, createdAt: { $gte: AUTO_SINCE } };
  const [missing, beforeAutoSince] = await Promise.all([
    donations.find(scoped(query, scope), { sort: { createdAt: -1, _id: -1 }, limit: 2000, fields: FIELDS, lean: true }),
    donations.count(scoped({ ...NO_RECEIPT, createdAt: { $lt: AUTO_SINCE } }, scope)),
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
    donations.count(
      scoped(
        {
          status: "completed",
          receiptNumber: { $nin: [null, ""] },
          whatsappReceiptSentAt: null,
          donorMobile: { $nin: [null, ""] },
          createdAt: { $gte: AUTO_SINCE },
        },
        scope
      )
    ),
    donations.count(scoped({ dccRecoveredAt: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } }, scope)),
  ]);

  return {
    autoSince: AUTO_SINCE,
    counts: { ...counts, receiptNoWhatsapp, recovered7d },
    donations: rows.slice(0, listLimit),
  };
}

const isSweepRunning = () => running;

export {
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
