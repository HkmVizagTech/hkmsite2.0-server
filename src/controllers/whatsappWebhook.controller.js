import { donations, claimUpdate } from "../domain/donationDb.js";

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
    inner.reason || (inner.error && (inner.error.message || inner.error.title)) || inner.title || "no reason supplied";
  return code ? `(#${code}) ${reason}` : String(reason);
}

async function applyMessageEvent(eventPayload) {
  const rawId = eventPayload.id || eventPayload.gsId;
  const messageId = rawId ? String(rawId) : rawId;
  const type = String(eventPayload.type || "").toLowerCase();
  if (!messageId || !type) return "ignored_incomplete_event";

  for (let attempt = 0; attempt < 5; attempt++) {
    // Matches whichever id we stored at send time.
    const donation = await donations.findOne(
      {
        $or: [{ whatsappMessageId: messageId }, { whatsappMessageId: String(eventPayload.gsId || messageId) }],
      },
      { sort: { createdAt: 1, _id: 1 } }
    );

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
      } else if (typeof incomingRank !== "number" || (typeof currentRank === "number" && incomingRank <= currentRank)) {
        return `stale_or_unknown_event:${type}`;
      }
    }

    const update = isFailure
      ? {
          whatsappDeliveryStatus: "failed",
          // Surfaces in the admin UI next to the send error from the API call itself.
          whatsappReceiptError: `WhatsApp delivery failed: ${describeFailure(eventPayload.payload)}`,
        }
      : {
          whatsappDeliveryStatus: type,
          ...(type === "delivered" || type === "read" ? { whatsappDeliveredAt: new Date() } : {}),
          ...(donation.whatsappDeliveryStatus === "failed" ? { whatsappReceiptError: null } : {}),
        };

    const written = await claimUpdate(
      { _id: donation._id, whatsappDeliveryStatus: donation.whatsappDeliveryStatus ?? null },
      update
    );
    if (written) return `${type}:${donation._id.toString()}`;
  }
  return `contended:${messageId}`;
}

const whatsappWebhookController = {
  // POST /webhooks/whatsapp/gupshup/:secret
  gupshup: async (req, res) => {
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

export { whatsappWebhookController };
