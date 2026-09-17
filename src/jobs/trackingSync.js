// src/jobs/trackingSync.js
//
// Auto-tracking sync for shop orders.
//
// The admin marks an order Shipped and saves a courier + tracking number.
// From that point on, this job watches the courier's own status feed and
// keeps the order in step with reality:
//
//   shipped  →  out for delivery  →  delivered
//
// The customer's order page already shows the tracking link the moment the
// admin saves, so the only gap this job fills is "the parcel arrived but
// nobody remembered to mark it delivered". When the courier says Delivered,
// the order flips automatically, the status history records the courier as
// the source ("auto: Delhivery"), and the change is visible on the
// customer's order page on their next visit/refresh.
//
// Safe to re-run: an order is only ever touched when the courier explicitly
// reports a status that is NEWER than the order's current state, and
// delivered orders are never re-checked. All failures are logged and
// swallowed — a courier outage must never take the job down.

const { shopOrderModel } = require("../models/shopOrder.model");
const {
  fetchCourierStatus,
  mapCourierStatusToOrderStatus,
} = require("../services/tracking.service");

// How often the job runs (default: every 2 hours). Overridable via env.
const INTERVAL_MINUTES = Number(process.env.TRACKING_SYNC_INTERVAL_MINUTES || 120);
// Cap per pass so a large shipped backlog can't make one pass run for minutes.
const BATCH_SIZE = Number(process.env.TRACKING_SYNC_BATCH_SIZE || 50);
// Orders are checked for at most N days after shipping — after that the job
// stops polling the courier for them (the customer can still use the
// tracking URL manually). Override or set 0 to disable the age limit.
const MAX_AGE_DAYS = Number(process.env.TRACKING_SYNC_MAX_AGE_DAYS || 30);
// Toggle for the whole job.
const ENABLED = process.env.TRACKING_SYNC_ENABLED !== "false";

// Statuses the courier feed can report, ranked newest-last for reference.
// (Orders are only ever selected in "shipped" state, so no rank comparison
// is needed at write time — delivered orders are never re-checked.)
const STATUS_RANK = {
  shipped: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
};

async function runTrackingSync() {
  if (!ENABLED) return { skipped: true, reason: "tracking_sync_disabled" };

  // Only shipped orders with a tracking number, shipped recently enough
  // that polling still makes sense.
  const floorDate =
    MAX_AGE_DAYS > 0
      ? new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
      : null;

  const filter = {
    fulfilmentStatus: "shipped",
    "tracking.trackingNumber": { $exists: true, $ne: "" },
  };
  // Prefer the explicit shippedAt timestamp when present; fall back to
  // createdAt for orders shipped before the field existed.
  if (floorDate) {
    filter.$and = [
      {
        $or: [
          { shippedAt: { $gte: floorDate } },
          { $and: [{ shippedAt: { $exists: false } }, { createdAt: { $gte: floorDate } }] },
        ],
      },
    ];
  }

  const orders = await shopOrderModel
    .find(filter)
    .sort({ updatedAt: -1 })
    .limit(BATCH_SIZE)
    .select(
      "orderNumber fulfilmentStatus tracking needsAttention statusHistory shippedAt createdAt"
    );

  if (orders.length === 0) {
    return { checked: 0, updated: 0, errors: 0 };
  }

  let updated = 0;
  let errors = 0;

  for (const order of orders) {
    const courier = String(order.tracking?.courier || "").trim();
    const trackingNumber = String(order.tracking?.trackingNumber || "").trim();
    if (!trackingNumber) continue;

    const { status: courierStatusText } = await fetchCourierStatus(courier, trackingNumber);
    if (!courierStatusText) {
      // Unknown courier, unconfigured API, or a network hiccup — try again
      // next pass. But if the admin never picked a courier, try to detect
      // it from the number's format and store the guess (this also fills
      // the customer-facing tracking URL below).
      if (!courier) {
        const { detectCourier, buildTrackingUrl } = require("../services/tracking.service");
        const guessed = detectCourier(trackingNumber);
        if (guessed) {
          order.tracking.courier = guessed;
          const url = buildTrackingUrl(guessed, trackingNumber);
          if (url && !order.tracking.url) order.tracking.url = url;
          try {
            await order.save();
          } catch (e) {
            console.error("trackingSync: could not save detected courier", e.message);
          }
        }
      }
      continue;
    }

    const mapped = mapCourierStatusToOrderStatus(courierStatusText);
    if (!mapped) continue; // courier text says nothing conclusive

    // out_for_delivery/in_transit are informational: they refine the customer
    // UI but are stored as a history note rather than a status change, so the
    // order's own state machine (placed → packed → shipped → delivered) is
    // untouched by anything short of actual delivery.

    if (mapped === "delivered") {
      order.fulfilmentStatus = "delivered";
      order.statusHistory.push({
        status: "delivered",
        note: `Auto-updated from ${courier || "courier"}: "${courierStatusText}"`,
        at: new Date(),
        // No admin user — the courier feed said so. statusHistory.byUserId is
        // optional in the schema, so leaving it out is fine.
      });
      try {
        await order.save();
      } catch (e) {
        errors += 1;
        console.error(`trackingSync: failed to mark ${order.orderNumber} delivered:`, e.message);
        continue;
      }
      updated += 1;
      console.log(
        `trackingSync: order ${order.orderNumber} auto-marked DELIVERED (${courier} ${trackingNumber})`
      );
    } else if (mapped === "exception") {
      // Don't flip the status automatically — RTO/damage needs a human
      // decision (refund? re-ship?). Flag for staff instead.
      if (!order.needsAttention) {
        order.needsAttention = true;
        order.statusHistory.push({
          status: "tracking_exception",
          note: `Courier reports: "${courierStatusText}" — needs staff review`,
          at: new Date(),
        });
        try {
          await order.save();
        } catch (e) {
          errors += 1;
          console.error(`trackingSync: failed to flag exception for ${order.orderNumber}:`, e.message);
          continue;
        }
        updated += 1;
        console.log(`tracking auto-flagged exception on ${order.orderNumber}: ${courierStatusText}`);
      }
    } else {
      // in_transit / out_for_delivery — refine only when there's news.
      const lastNote = order.statusHistory[order.statusHistory.length - 1];
      const isRepeat = lastNote && lastNote.status === "tracking_note" && lastNote.note === `Auto: ${courierStatusText}`;
      if (!isRepeat) {
        order.statusHistory.push({
          status: "tracking_note",
          note: `Auto: ${courierStatusText}`,
          at: new Date(),
        });
        try {
          await order.save();
        } catch (e) {
          errors += 1;
          console.error(`trackingSync: failed to save tracking note for ${order.orderNumber}:`, e.message);
          continue;
        }
      }
    }
  }

  return { checked: orders.length, updated, errors };
}

function startTrackingSyncJob() {
  if (!ENABLED) {
    console.log("[trackingSync] disabled via TRACKING_SYNC_ENABLED=false");
    return;
  }
  // Stagger the first pass after boot like the other jobs, then run on the
  // interval. Errors are swallowed per-run so one bad pass never kills the
  // schedule.
  const run = () => {
    runTrackingSync()
      .then((result) => {
        if (result && result.checked > 0) {
          console.log(
            `[trackingSync] pass: ${result.checked} checked, ${result.updated} updated, ${result.errors} errors`
          );
          return;
        }
      })
      .catch((err) => {
        console.error("[trackingSync] scheduled run failed:", err && err.stack ? err.stack : err);
      });
  };
  setTimeout(run, 90 * 1000);
  setInterval(run, INTERVAL_MINUTES * 60 * 1000);
  console.log(`[trackingSync] scheduled every ${INTERVAL_MINUTES} min (batch ${BATCH_SIZE})`);
}

module.exports = { startTrackingSyncJob, runTrackingSync };
