// Auto-tracking sync: keeps shipped shop orders in step with the courier feed (delivered / exception / notes).
// Only shipped orders are selected, delivered ones are never re-checked, failures are logged and swallowed.

import { query } from "../db/pg.js";
import { shopOrders } from "../db/tables.js";
import { ms, selectRows } from "../domain/shop.js";
import {
  fetchCourierStatus,
  mapCourierStatusToOrderStatus,
  detectCourier,
  buildTrackingUrl,
} from "../services/tracking.service.js";

// How often the job runs (default: every 2 hours). Overridable via env.
const INTERVAL_MINUTES = Number(process.env.TRACKING_SYNC_INTERVAL_MINUTES || 120);
// Cap per pass so a large shipped backlog can't make one pass run for minutes.
const BATCH_SIZE = Number(process.env.TRACKING_SYNC_BATCH_SIZE || 50);
const MAX_AGE_DAYS = Number(process.env.TRACKING_SYNC_MAX_AGE_DAYS || 30);
// Toggle for the whole job.
const ENABLED = process.env.TRACKING_SYNC_ENABLED !== "false";

const STATUS_RANK = {
  shipped: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
};

const pushHistory = (id, entries, extraSet = "", guard = "") =>
  query(
    `UPDATE shop_orders SET status_history = status_history || $2::jsonb, updated_at = $3${extraSet} WHERE id = $1${guard}`,
    [id, JSON.stringify(entries), new Date()]
  );

async function runTrackingSync() {
  if (!ENABLED) return { skipped: true, reason: "tracking_sync_disabled" };

  // Only shipped orders with a tracking number, shipped recently enough
  // that polling still makes sense.
  const floorDate = MAX_AGE_DAYS > 0 ? new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000) : null;

  const filter = {
    fulfilmentStatus: "shipped",
    "tracking.trackingNumber": { $exists: true, $ne: "" },
  };
  // shippedAt when present, createdAt for orders shipped before the field existed.
  if (floorDate) {
    filter.$raw = ["(shipped_at >= ? OR (shipped_at IS NULL AND created_at >= ?))", [floorDate, floorDate]];
  }

  const orders = await selectRows(shopOrders, filter, `${ms("updated_at")} DESC, id`, { limit: BATCH_SIZE });

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
      if (!courier) {
        const guessed = detectCourier(trackingNumber);
        if (guessed) {
          const url = buildTrackingUrl(guessed, trackingNumber);
          try {
            await query(
              "UPDATE shop_orders SET tracking_courier = $2, tracking_url = COALESCE(tracking_url, $3), updated_at = $4 WHERE id = $1",
              [order._id, guessed, url || null, new Date()]
            );
          } catch (e) {
            console.error("trackingSync: could not save detected courier", e.message);
          }
        }
      }
      continue;
    }

    const mapped = mapCourierStatusToOrderStatus(courierStatusText);
    if (!mapped) continue; // courier text says nothing conclusive

    if (mapped === "delivered") {
      try {
        // Guarded so an admin change made since the batch was read is not overwritten.
        await pushHistory(
          order._id,
          [
            {
              status: "delivered",
              note: `Auto-updated from ${courier || "courier"}: "${courierStatusText}"`,
              at: new Date(),
            },
          ],
          ", fulfilment_status = 'delivered'",
          " AND fulfilment_status = 'shipped'"
        );
      } catch (e) {
        errors += 1;
        console.error(`trackingSync: failed to mark ${order.orderNumber} delivered:`, e.message);
        continue;
      }
      updated += 1;
      console.log(`trackingSync: order ${order.orderNumber} auto-marked DELIVERED (${courier} ${trackingNumber})`);
    } else if (mapped === "exception") {
      // Don't flip the status automatically — RTO/damage needs a human
      // decision (refund? re-ship?). Flag for staff instead.
      if (!order.needsAttention) {
        try {
          await pushHistory(
            order._id,
            [
              {
                status: "tracking_exception",
                note: `Courier reports: "${courierStatusText}" — needs staff review`,
                at: new Date(),
              },
            ],
            ", needs_attention = true"
          );
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
      const lastNote = (order.statusHistory || [])[(order.statusHistory || []).length - 1];
      const isRepeat =
        lastNote && lastNote.status === "tracking_note" && lastNote.note === `Auto: ${courierStatusText}`;
      if (!isRepeat) {
        try {
          await pushHistory(order._id, [
            { status: "tracking_note", note: `Auto: ${courierStatusText}`, at: new Date() },
          ]);
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

export { startTrackingSyncJob, runTrackingSync };
