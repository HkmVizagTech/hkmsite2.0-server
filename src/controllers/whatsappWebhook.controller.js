// src/controllers/whatsappWebhook.controller.js
//
// Gupshup delivery callback.
//
// WHY THIS EXISTS
// The send API answers {"status":"submitted"} the instant Gupshup accepts the
// request — that is NOT delivery. Meta can still reject the message afterwards
// (number not on WhatsApp, template paused, quality/spam limit, document link
// unreachable), and without a callback the donation record keeps saying the
// receipt was sent while the donor has nothing. This endpoint records what
// actually happened, so the admin "Needs WhatsApp" tab reflects reality.
//
// GUPSHUP CALLBACK CONTRACT (self-serve WhatsApp API)
//   Gupshup POSTs application/json to the callback URL configured for the app:
//     {
//       "app": "<app name>", "timestamp": 1580227766370, "version": 2,
//       "type": "message-event",
//       "payload": {
//         "id": "<the messageId returned by the send API>",
//         "gsId": "<gupshup internal id>",
//         "type": "enqueued" | "sent" | "delivered" | "read" | "failed" | "deleted",
//         "destination": "9199xxxxxxxx",
//         "payload": { "ts": 1580227766000, "whatsappMessageId": "gBEG...",
//                      "code": 131026, "reason": "..." }   // code/reason on failure
//       }
//     }
//   Other `type` values arrive too ("message" for an inbound reply,
//   "user-event", "billing-event", "template-event"). They are acknowledged and
//   ignored here rather than treated as errors.
//
// TWO RULES THIS ENDPOINT FOLLOWS
//   1. ALWAYS answer 200, even for an unknown message id or a payload we don't
//      understand. Gupshup retries non-2xx responses, and a retry storm over an
//      event we were never going to act on is worse than dropping it.
//   2. NEVER move a donation's status backwards. Events can arrive out of
//      order, so a late "sent" must not overwrite an already-recorded
//      "delivered" (see STATUS_RANK).

const { donationModel } = require("../models/donation.model");

// Ordered so a later event can only advance the status, never regress it.
// "failed" is deliberately outside this ladder — it is terminal and always
// recorded, whatever came before.
const STATUS_RANK = {
  submitted: 0,
  enqueued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

const FAILURE_TYPES = new Set(["failed", "deleted"]);

function describeFailure(inner) {
  if (!inner || typeof inner !== "object") return "Meta rejected the message (no reason supplied)";
  const code = inner.code || (inner.error && inner.error.code);
  const reason =
    inner.reason ||
    (inner.error && (inner.error.message || inner.error.title)) ||
    inner.title ||
    "no reason supplied";
  return code ? `(#${code}) ${reason}` : String(reason);
}

/**
 * Applies one message-event to the donation it belongs to.
 * Returns a short string describing what was done (for the log line).
 */
async function applyMessageEvent(eventPayload) {
  const messageId = eventPayload.id || eventPayload.gsId;
  const type = String(eventPayload.type || "").toLowerCase();
  if (!messageId || !type) return "ignored_incomplete_event";

  // Matches whichever id we stored at send time.
  const donation = await donationModel.findOne({
    $or: [{ whatsappMessageId: messageId }, { whatsappMessageId: eventPayload.gsId || messageId }],
  });

  // Not one of ours — pending reminders, CRM campaigns and test sends all
  // land on the same callback URL. Nothing to do, and definitely not an error.
  if (!donation) return `no_matching_donation:${messageId}`;

  const isFailure = FAILURE_TYPES.has(type);
  const currentRank = STATUS_RANK[donation.whatsappDeliveryStatus];
  const incomingRank = STATUS_RANK[type];

  if (!isFailure) {
    if (donation.whatsappDeliveryStatus === "failed") {
      // A success event after a recorded failure: Meta actually got it
      // through (e.g. a retry). Let it advance and clear the error.
    } else if (
      typeof incomingRank !== "number" ||
      (typeof currentRank === "number" && incomingRank <= currentRank)
    ) {
      return `stale_or_unknown_event:${type}`;
    }
  }

  const update = isFailure
    ? {
        whatsappDeliveryStatus: "failed",
        // Surfaces in the admin UI next to the send error from the API call
        // itself, so both classes of failure read the same way.
        whatsappReceiptError: `WhatsApp delivery failed: ${describeFailure(eventPayload.payload)}`,
      }
    : {
        whatsappDeliveryStatus: type,
        ...(type === "delivered" || type === "read" ? { whatsappDeliveredAt: new Date() } : {}),
        ...(donation.whatsappDeliveryStatus === "failed" ? { whatsappReceiptError: null } : {}),
      };

  await donationModel.findByIdAndUpdate(donation._id, update);

  // NOTE: whatsappReceiptSentAt is deliberately NOT cleared on failure. It is
  // the hard idempotency guard that stops a donor ever getting two receipts,
  // and a "failed" event is Meta's report, not proof the donor saw nothing.
  // Failed sends stay visible to admins through the Needs WhatsApp tab (which
  // includes whatsappDeliveryStatus: "failed") and are resent with the
  // explicit, human-initiated Resend button, which passes force: true.
  return `${type}:${donation._id.toString()}`;
}

const whatsappWebhookController = {
  // POST /webhooks/whatsapp/gupshup/:secret
  gupshup: async (req, res) => {
    // Gupshup's self-serve callbacks are unsigned, so the shared secret lives
    // in the URL path. If GUPSHUP_WEBHOOK_SECRET is unset the endpoint still
    // works (so a misconfigured env var loses no events) but says so loudly.
    const expected = process.env.GUPSHUP_WEBHOOK_SECRET;
    if (expected) {
      if (req.params.secret !== expected) {
        console.warn("[Gupshup webhook] rejected a call with a bad secret from", req.ip);
        return res.status(404).json({ message: "Not found" });
      }
    } else {
      console.warn(
        "[Gupshup webhook] GUPSHUP_WEBHOOK_SECRET is not set — this endpoint is accepting unauthenticated callbacks. Set it in Railway and use the same value in the Gupshup callback URL."
      );
    }

    // Answer FIRST, process after. Gupshup times these out quickly and retries
    // on a slow response, which would double-apply the same event.
    res.status(200).json({ received: true });

    try {
      const body = req.body || {};
      // Gupshup sends one event per call, but a batching proxy in front of it
      // (or a future version) may send an array — handle both.
      const events = Array.isArray(body) ? body : [body];

      for (const event of events) {
        const type = String(event.type || "").toLowerCase();
        if (type !== "message-event") {
          // Inbound donor replies land here as type "message". Worth knowing
          // about (a donor replying to a receipt is a real person waiting on
          // an answer), so log it rather than dropping it silently.
          if (type === "message") {
            const from = event.payload && event.payload.sender && event.payload.sender.phone;
            console.log("[Gupshup webhook] inbound WhatsApp message from", from || "unknown");
          }
          continue;
        }

        const result = await applyMessageEvent(event.payload || {});
        console.log("[Gupshup webhook] message-event ->", result);
      }
    } catch (err) {
      // The response has already gone out; this can only be logged.
      console.error("[Gupshup webhook] failed to process event:", err && err.stack ? err.stack : err);
    }
  },
};

module.exports = { whatsappWebhookController };
