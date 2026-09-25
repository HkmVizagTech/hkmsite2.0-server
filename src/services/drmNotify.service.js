// Live push to the HKM Vizag DRM (donor relationship manager, a separate
// PostgreSQL/Express app). When a donation completes here, DRM should show
// it immediately rather than waiting for someone to press "sync" - so the
// post-completion pipeline calls notifyDrmOfDonation() and DRM upserts the
// donor's whole current snapshot.
//
// SAFETY CONTRACT - this runs inside the live donation pipeline:
//   * It NEVER throws. Every path is caught and logged.
//   * It NEVER blocks a donation. The caller does not await the network call,
//     and the request carries a hard timeout so a hung DRM can't pin a socket.
//   * If DRM is down, misconfigured, or slow, the donation still completes,
//     the receipt still generates, and WhatsApp still goes out - the only
//     consequence is DRM being briefly stale, which the backfill import or
//     the per-donor "Sync from HKMV" button reconciles later.
// A failed push is therefore a soft, self-healing failure by design. Do not
// "improve" this by awaiting it or letting it throw.

const REQUEST_TIMEOUT_MS = 8000;

// Accepts a bare host ("drm-server-production.up.railway.app") or a full URL,
// and tolerates a trailing slash - a value pasted without a scheme would
// otherwise make fetch() throw "Failed to parse URL" on every donation.
function normalizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare local host means a dev server, which won't be serving TLS -
  // defaulting those to https would fail the handshake. Everything else
  // (a real deployment) gets https.
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

function isConfigured() {
  return Boolean(normalizeBaseUrl(process.env.DRM_API_URL) && process.env.DRM_INTERNAL_SECRET);
}

// Resolves the donor identity record for a donation, falling back to a mobile
// lookup when donorRecordId wasn't linked (the linking step in the pipeline is
// itself non-fatal, so it can legitimately be missing).
async function resolveDonorForDonation(donation) {
  const { donorModel } = require("../models/donor.model");

  if (donation.donorRecordId) {
    const byId = await donorModel.findById(donation.donorRecordId).lean();
    if (byId) return byId;
  }
  if (donation.donorMobile) {
    const mobile = String(donation.donorMobile).replace(/\s+/g, "").replace(/^\+?91/, "");
    if (mobile) return donorModel.findOne({ mobile }).lean();
  }
  return null;
}

// Pushes the donor's full current snapshot to DRM. Awaiting this is allowed
// (the caller runs detached from the donor's HTTP response) but it resolves to
// a result object rather than throwing, so it can also be fired un-awaited.
async function notifyDrmOfDonation(donationId, { reason = "donation_completed" } = {}) {
  try {
    if (!isConfigured()) {
      // Not an error - DRM integration simply isn't switched on in this
      // environment. Stay quiet so local/dev logs aren't noisy.
      return { ok: false, skipped: true, reason: "not_configured" };
    }

    const { donationModel } = require("../models/donation.model");
    const donation = await donationModel.findById(donationId).lean();
    if (!donation) return { ok: false, skipped: true, reason: "donation_not_found" };

    const donor = await resolveDonorForDonation(donation);
    if (!donor) return { ok: false, skipped: true, reason: "no_donor_record" };

    // Same snapshot shape the pull API returns, so DRM runs one upsert path
    // for both push and pull instead of two that can drift.
    const { buildDonorSnapshot } = require("../controllers/internal.controller");
    const snapshot = await buildDonorSnapshot(donor);

    const baseUrl = normalizeBaseUrl(process.env.DRM_API_URL);
    const res = await fetch(`${baseUrl}/api/webhooks/hkmv/donor-updated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": process.env.DRM_INTERNAL_SECRET,
      },
      body: JSON.stringify({
        reason,
        triggeredByDonationId: String(donationId),
        found: true,
        ...snapshot,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `DRM push returned ${res.status} for donation ${donationId} (non-fatal):`,
        body.slice(0, 200)
      );
      return { ok: false, status: res.status };
    }

    return { ok: true };
  } catch (err) {
    // Includes timeouts, DNS failures, DRM being down - all non-fatal.
    console.warn(
      `DRM push failed for donation ${donationId} (non-fatal, DRM will catch up on next sync/import):`,
      err && err.message ? err.message : err
    );
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

module.exports = { notifyDrmOfDonation, isConfigured };
