import { donations, donors } from "../db/tables.js";
import { buildDonorSnapshot } from "../controllers/internal.controller.js";

// Live push to the HKM Vizag DRM (donor relationship manager, a separate

const REQUEST_TIMEOUT_MS = 8000;

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

function isConfigured() {
  return Boolean(normalizeBaseUrl(process.env.DRM_API_URL) && process.env.DRM_INTERNAL_SECRET);
}

async function resolveDonorForDonation(donation) {
  if (donation.donorRecordId) {
    const byId = await donors.findById(donation.donorRecordId, { lean: true });
    if (byId) return byId;
  }
  if (donation.donorMobile) {
    const mobile = String(donation.donorMobile)
      .replace(/\s+/g, "")
      .replace(/^\+?91/, "");
    if (mobile) return donors.findOne({ mobile }, { sort: { _id: 1 }, lean: true });
  }
  return null;
}

async function notifyDrmOfDonation(donationId, { reason = "donation_completed" } = {}) {
  try {
    if (!isConfigured()) {
      // Not an error - DRM integration simply isn't switched on in this
      // environment. Stay quiet so local/dev logs aren't noisy.
      return { ok: false, skipped: true, reason: "not_configured" };
    }

    const donation = await donations.findById(donationId, { lean: true });
    if (!donation) return { ok: false, skipped: true, reason: "donation_not_found" };

    const donor = await resolveDonorForDonation(donation);
    if (!donor) return { ok: false, skipped: true, reason: "no_donor_record" };

    // Same snapshot shape the pull API returns, so DRM runs one upsert path
    // for both push and pull instead of two that can drift.

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
      console.warn(`DRM push returned ${res.status} for donation ${donationId} (non-fatal):`, body.slice(0, 200));
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

export { notifyDrmOfDonation, isConfigured };
