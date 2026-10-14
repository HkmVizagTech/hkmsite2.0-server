import crypto from "node:crypto";
import { donations } from "../db/tables.js";

const GRAPH_VERSION = "v21.0";

const sha256 = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash("sha256").update(normalized).digest("hex");
};

// Phone numbers must be hashed WITHOUT the leading + but WITH country code,
// digits only. Indian numbers stored as 10 digits get a 91 prefix.
const hashPhone = (mobile) => {
  if (!mobile) return undefined;
  let digits = String(mobile).replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (!digits) return undefined;
  return crypto.createHash("sha256").update(digits).digest("hex");
};

// Names: hash first and last name separately, lowercased, no whitespace.
const splitName = (fullName) => {
  if (!fullName) return { fn: undefined, ln: undefined };
  const parts = String(fullName).trim().split(/\s+/);
  const fn = parts[0];
  const ln = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return { fn: sha256(fn), ln: sha256(ln) };
};

async function sendPurchaseEvent(donation) {
  try {
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_CAPI_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      // Not configured — silently skip (donations still work fine).
      return { skipped: true, reason: "Meta CAPI not configured" };
    }
    if (!donation || donation.metaPurchaseSentAt) {
      // Already sent, or nothing to send — avoid double-counting.
      return { skipped: true, reason: "already sent or no donation" };
    }

    const { fn, ln } = splitName(donation.donorName);

    const userData = {
      em: sha256(donation.donorEmail),
      ph: hashPhone(donation.donorMobile),
      fn,
      ln,
      // fbc/fbp are already Meta-generated identifiers — sent raw, not hashed.
      fbc: donation.metaFbc || undefined,
      fbp: donation.metaFbp || undefined,
      client_ip_address: donation.metaClientIp || undefined,
      client_user_agent: donation.metaUserAgent || undefined,
    };
    // Strip undefined keys (Meta rejects null values).
    Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

    const eventId = donation.metaEventId || `donation_${donation._id}`;

    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId, // must match the browser pixel event for dedup
          event_source_url: donation.sourcePage
            ? `https://www.harekrishnavizag.org${donation.sourcePage.startsWith("/") ? "" : "/"}${donation.sourcePage}`
            : "https://www.harekrishnavizag.org",
          action_source: "website",
          user_data: userData,
          custom_data: {
            currency: "INR",
            value: Number(donation.amount) || 0,
            content_name: donation.sevaName || donation.type || "Donation",
            content_category: donation.type || "Donation",
          },
        },
      ],
    };

    if (process.env.META_TEST_EVENT_CODE) {
      payload.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.warn("[MetaCAPI] Purchase event rejected:", JSON.stringify(body).slice(0, 400));
      return { success: false, error: body };
    }

    // Mark as sent so retries/webhooks don't double-report.
    try {
      await donations.updateById(donation._id, { metaPurchaseSentAt: new Date() });
    } catch (e) {
      // non-fatal
    }

    console.log("[MetaCAPI] Purchase event sent:", eventId, "events_received:", body.events_received);
    return { success: true, body };
  } catch (err) {
    console.warn("[MetaCAPI] sendPurchaseEvent error:", err && err.message ? err.message : err);
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

export { sendPurchaseEvent };
