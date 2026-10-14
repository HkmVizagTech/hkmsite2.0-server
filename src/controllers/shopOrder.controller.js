import crypto from "node:crypto";
import { many, query, tx } from "../db/pg.js";
import { products, shopOrders, donors } from "../db/tables.js";
import {
  resolvePurchasable,
  getShopSettings,
  calculateShipping,
  attachVariants,
  attachItems,
  insertOrderItems,
  ms,
  selectRows,
  wholeNumber,
  searchMatcher,
} from "../domain/shop.js";
import { castIdParam, castString, idFilterValue, looseObjectId, queryValue } from "../domain/shopSchema.js";
import { getNextSequence } from "../utils/counter.js";
import { IST } from "../config/timezone.js";
import { createRazorpayInstance } from "./payment.controller.js";
import { isWhatsAppConfigured, sendUtilityMessage } from "../services/whatsapp.service.js";
import * as trackingService from "../services/tracking.service.js";

// A shop order never runs completeDonation(): no DCC sync, no 80G receipt, no donation template.
const SHOP_ACCOUNT = process.env.SHOP_RAZORPAY_ACCOUNT || "shop";

function resolveShopRazorpay() {
  const shop = createRazorpayInstance(SHOP_ACCOUNT);
  if (shop) return shop;
  console.warn(
    `Shop Razorpay account "${SHOP_ACCOUNT}" is not configured — falling back to the donations account. ` +
      `Set RAZORPAY_SHOP_KEY_ID and RAZORPAY_SHOP_KEY_SECRET to sell through the separate shop account.`
  );
  return createRazorpayInstance("donations") || createRazorpayInstance("default");
}

async function generateOrderNumber() {
  const seq = await getNextSequence("shopOrder");
  // Year pinned to IST: an order at 00:30 IST on 1 January must not get the previous year.
  const year = new Date().toLocaleDateString("en-GB", { timeZone: IST, year: "numeric" });
  return `HKMS-${year}-${String(seq).padStart(5, "0")}`;
}

async function loadOrder(filter, client, { lean = false } = {}) {
  const order = await shopOrders.findOne(filter, { client, lean });
  if (!order) return null;
  await attachItems([order], client, { lean });
  return order;
}

const historyEntry = (status, note, extra = {}) => ({ status, note: note || undefined, at: new Date(), ...extra });

// What `new Model(...).save()` would reject on a history entry: note/status are strings, byUserId an ObjectId.
function checkedHistory(entries) {
  return entries.map((e) => {
    const note = castString(e.note, "statusHistory.note");
    if (e.byUserId !== undefined && e.byUserId !== null && looseObjectId(e.byUserId) === null) {
      throw new Error(`Cast to ObjectId failed for value ${JSON.stringify(e.byUserId)} at path "byUserId"`);
    }
    return { ...e, note, byUserId: e.byUserId == null ? e.byUserId : looseObjectId(e.byUserId) };
  });
}

// Rebuilds the cart from the catalog; the browser only sends ids and quantities, never prices.
async function buildCartFromRequest(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: "Your cart is empty." };
  }
  if (rawItems.length > 50) {
    return { error: "That's too many different items for one order." };
  }

  const items = [];
  const problems = [];
  let subtotal = 0;

  for (const raw of rawItems) {
    const quantity = Math.floor(Number(raw.quantity) || 0);
    if (quantity < 1 || quantity > 99) {
      problems.push({
        productId: raw.productId,
        reason: "invalid_quantity",
        message: "Choose a quantity between 1 and 99.",
      });
      continue;
    }

    let product = null;
    if (raw.productId !== undefined && raw.productId !== null) {
      product = await products.findOne({ _id: idFilterValue(raw.productId, "product", "_id") }, { lean: true });
      if (product) await attachVariants([product], undefined, { lean: true });
    }
    if (!product || product.status !== "active") {
      problems.push({ productId: raw.productId, reason: "unavailable", message: "This item is no longer available." });
      continue;
    }

    const purchasable = resolvePurchasable(product, raw.variantId);
    if (!purchasable) {
      problems.push({
        productId: raw.productId,
        reason: "variant_unavailable",
        message: `Choose an available option for ${product.name}.`,
      });
      continue;
    }

    if ((Number(purchasable.stock) || 0) < quantity) {
      problems.push({
        productId: raw.productId,
        variantId: raw.variantId,
        reason: "insufficient_stock",
        available: Number(purchasable.stock) || 0,
        message:
          (Number(purchasable.stock) || 0) === 0
            ? `${product.name} is out of stock.`
            : `Only ${purchasable.stock} left of ${product.name}${purchasable.variantLabel ? ` (${purchasable.variantLabel})` : ""}.`,
      });
      continue;
    }

    const lineTotal = Math.round(purchasable.price * quantity * 100) / 100;
    subtotal += lineTotal;
    items.push({
      productId: product._id,
      productName: product.name,
      slug: product.slug,
      image: (product.images || [])[0],
      variantId: purchasable.variantId,
      variantLabel: purchasable.variantLabel,
      unitPrice: purchasable.price,
      mrp: purchasable.mrp,
      quantity,
      lineTotal,
      freeShipping: !!product.freeShipping,
    });
  }

  return { items, subtotal: Math.round(subtotal * 100) / 100, problems };
}

// Conditional decrement: succeeds only while the shelf still holds enough, which is the oversell guard.
async function decrementStock(client, item) {
  if (item.variantId) {
    const r = await client.query(
      `WITH v AS (
         UPDATE product_variants SET stock = stock - $1
         WHERE id = $2 AND product_id = $3 AND stock >= $1 RETURNING product_id
       )
       UPDATE products SET updated_at = $4 WHERE id IN (SELECT product_id FROM v) RETURNING id`,
      [item.quantity, item.variantId, item.productId, new Date()]
    );
    return r.rowCount > 0;
  }
  if (!item.productId) return false;
  const r = await client.query(
    "UPDATE products SET stock = stock - $1, updated_at = $3 WHERE id = $2 AND stock >= $1 RETURNING id",
    [item.quantity, item.productId, new Date()]
  );
  return r.rowCount > 0;
}

async function restoreStock(client, item) {
  if (!item.productId) return;
  if (item.variantId) {
    await client.query(
      `WITH v AS (
         UPDATE product_variants SET stock = COALESCE(stock, 0) + $1 WHERE id = $2 AND product_id = $3 RETURNING product_id
       )
       UPDATE products SET updated_at = $4 WHERE id IN (SELECT product_id FROM v)`,
      [item.quantity, item.variantId, item.productId, new Date()]
    );
  } else {
    await client.query("UPDATE products SET stock = COALESCE(stock, 0) + $1, updated_at = $3 WHERE id = $2", [
      item.quantity,
      item.productId,
      new Date(),
    ]);
  }
}

async function availableStock(client, item) {
  if (!item.productId) return 0;
  if (item.variantId) {
    const r = await client.query("SELECT stock FROM product_variants WHERE id = $1 AND product_id = $2", [
      item.variantId,
      item.productId,
    ]);
    return r.rows[0]?.stock || 0;
  }
  const r = await client.query("SELECT stock FROM products WHERE id = $1", [item.productId]);
  return r.rows[0]?.stock || 0;
}

// Marks an order paid and commits its stock in one transaction. The pending->paid claim makes a
// second call (verify racing the webhook) a no-op, so stock is decremented exactly once.
async function confirmShopOrderPaid({ orderId, razorpayOrderId, paymentId }) {
  if (!orderId && !razorpayOrderId) return { ok: false, reason: "no_identifier" };
  const paymentIdText = castString(paymentId, "razorpayPaymentId");

  const claimed = await tx(async (client) => {
    const now = new Date();
    const params = [paymentIdText ?? null, JSON.stringify([historyEntry("paid", "Payment confirmed")]), now];
    let match;
    if (orderId) {
      params.push(orderId);
      match = "id = $4";
    } else {
      params.push(razorpayOrderId);
      match = "razorpay_order_id = $4";
    }
    const r = await client.query(
      `UPDATE shop_orders SET payment_status = 'paid', paid_at = $3, razorpay_payment_id = COALESCE($1, razorpay_payment_id),
         status_history = status_history || $2::jsonb, updated_at = $3
       WHERE id = (SELECT id FROM shop_orders WHERE payment_status = 'pending' AND ${match} ORDER BY created_at, id LIMIT 1 FOR UPDATE)
       RETURNING *`,
      params
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const order = shopOrders.fromRow(row);
    await attachItems([order], client);

    const shortfall = [];
    if (!row.stock_committed) {
      // Lock rows in a fixed order so two overlapping orders can't deadlock.
      const sorted = order.items
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) =>
          `${a.item.productId}|${a.item.variantId}` < `${b.item.productId}|${b.item.variantId}` ? -1 : 1
        );
      const failed = new Map();
      for (const { item, idx } of sorted) {
        if (!(await decrementStock(client, item))) {
          failed.set(idx, {
            productId: item.productId,
            productName: item.productName,
            variantLabel: item.variantLabel,
            requested: item.quantity,
            available: await availableStock(client, item),
          });
        }
      }
      for (let i = 0; i < order.items.length; i++) if (failed.has(i)) shortfall.push(failed.get(i));
    }

    const history = shortfall.length
      ? [
          historyEntry(
            "stock_shortfall",
            `Paid, but ${shortfall.length} item(s) could not be fully reserved. Needs staff review.`
          ),
        ]
      : [];
    const updated = await client.query(
      `UPDATE shop_orders SET stock_committed = true,
         stock_shortfall = CASE WHEN $1::jsonb = '[]'::jsonb THEN stock_shortfall ELSE $1::jsonb END,
         needs_attention = needs_attention OR $2,
         status_history = status_history || $3::jsonb, updated_at = $5
       WHERE id = $4 RETURNING *`,
      [JSON.stringify(shortfall), shortfall.length > 0, JSON.stringify(history), order._id, new Date()]
    );
    const final = shopOrders.fromRow(updated.rows[0]);
    final.items = order.items;
    return { order: final, shortfall };
  });

  if (!claimed) {
    const existing = await loadOrder(orderId ? { _id: orderId } : { razorpayOrderId });
    if (existing) return { ok: true, skipped: true, reason: "already_confirmed", order: existing };
    return { ok: false, reason: "order_not_found" };
  }
  return { ok: true, order: claimed.order, shortfall: claimed.shortfall };
}

// Fire-and-forget: a messaging failure must never turn a paid order into an error.
async function sendOrderWhatsApp(order) {
  try {
    if (!isWhatsAppConfigured()) return;

    const lines = order.items
      .map((i) => `• ${i.productName}${i.variantLabel ? ` (${i.variantLabel})` : ""} × ${i.quantity}`)
      .join("\n");
    const message =
      `Hare Krishna ${order.customerName}! Your order ${order.orderNumber} is confirmed.\n\n${lines}\n\n` +
      `Total paid: ₹${order.total.toLocaleString("en-IN")}\n` +
      `We'll message you again when it ships. Thank you for your support.`;

    await sendUtilityMessage(order.customerMobile, message);
    await shopOrders.updateById(order._id, { whatsappConfirmationSentAt: new Date(), updatedAt: new Date() });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn("shopOrder WhatsApp confirmation failed:", message);
    await shopOrders
      .updateById(order._id, { whatsappConfirmationError: message.slice(0, 300), updatedAt: new Date() })
      .catch(() => {});
  }
}

// What Mongoose's required/cast rules would have rejected when saving the order.
function assertOrderSavable({ name, mobile, email, items, subtotal, total }) {
  const bad = (what) => new Error(`shopOrder validation failed: ${what}`);
  if (!name) throw bad("customerName");
  if (typeof mobile !== "string" || !mobile.length) throw bad("customerMobile");
  if (typeof subtotal !== "number" || typeof total !== "number") throw bad("subtotal/total");
  if (!items.length) throw bad("items");
  for (const i of items) {
    if (typeof i.productName !== "string" || !i.productName.length) throw bad("items.productName");
    if (typeof i.unitPrice !== "number" || typeof i.lineTotal !== "number") throw bad("items.unitPrice");
    castString(i.slug, "slug");
    castString(i.image, "image");
  }
  return castString(email, "customerEmail");
}

const shopOrderController = {
  quoteCart: async (req, res) => {
    try {
      const settings = await getShopSettings();
      const cart = await buildCartFromRequest(req.body.items);
      if (cart.error) return res.status(400).json({ success: false, message: cart.error });

      const shippingCharge = cart.items.length ? calculateShipping(cart.subtotal, settings, cart.items) : 0;
      res.status(200).json({
        success: true,
        items: cart.items,
        problems: cart.problems,
        subtotal: cart.subtotal,
        shippingCharge,
        total: Math.round((cart.subtotal + shippingCharge) * 100) / 100,
        freeShippingAbove: settings.freeShippingAbove,
        shopEnabled: settings.shopEnabled,
      });
    } catch (err) {
      console.error("shopOrder.quoteCart error:", err);
      res.status(500).json({ success: false, message: "Could not price your cart." });
    }
  },

  // Stock is checked here but only decremented on payment (see confirmShopOrderPaid).
  createOrder: async (req, res) => {
    try {
      const settings = await getShopSettings();
      if (!settings.shopEnabled) {
        return res
          .status(503)
          .json({ success: false, message: "The shop is temporarily closed. Please try again later." });
      }

      const donorKey = idFilterValue(req.donor.donorId, "donor", "_id");
      const donor = donorKey === null ? null : await donors.findOne({ _id: donorKey }, { lean: true });
      if (!donor) return res.status(404).json({ success: false, message: "Customer record not found." });

      const { shippingAddress = {}, customerNote, customerName, customerEmail } = req.body || {};
      const street = String(shippingAddress.street || "").trim();
      const city = String(shippingAddress.city || "").trim();
      const state = String(shippingAddress.state || "").trim();
      const pincode = String(shippingAddress.pincode || "").trim();
      if (!street || !city || !state || !/^\d{6}$/.test(pincode)) {
        return res.status(400).json({
          success: false,
          message: "Please provide a complete delivery address with a valid 6-digit PIN code.",
        });
      }

      const name = String(customerName || donor.name || "").trim();
      if (!name) return res.status(400).json({ success: false, message: "Please tell us who this order is for." });

      const cart = await buildCartFromRequest(req.body.items);
      if (cart.error) return res.status(400).json({ success: false, message: cart.error });
      if (cart.problems.length || cart.items.length === 0) {
        return res.status(400).json({
          success: false,
          message: cart.problems[0]?.message || "Some items in your cart are unavailable.",
          problems: cart.problems,
        });
      }

      const shippingCharge = calculateShipping(cart.subtotal, settings, cart.items);
      const total = Math.round((cart.subtotal + shippingCharge) * 100) / 100;
      if (total < 1) return res.status(400).json({ success: false, message: "Order total is too low." });

      const razorpay = resolveShopRazorpay();
      if (!razorpay) {
        return res
          .status(500)
          .json({ success: false, message: "Payments aren't configured. Please contact the temple." });
      }

      const orderNumber = await generateOrderNumber();
      const rzpOrder = await razorpay.instance.orders.create({
        amount: Math.round(total * 100),
        currency: "INR",
        receipt: orderNumber,
        payment_capture: 1,
        notes: { type: "shop_order", orderNumber, mobile: donor.mobile },
      });

      const email = assertOrderSavable({
        name,
        mobile: donor.mobile,
        email: customerEmail || donor.email,
        items: cart.items,
        subtotal: cart.subtotal,
        total,
      });
      const now = new Date();
      const order = await tx(async (client) => {
        const created = await shopOrders.insert(
          {
            orderNumber,
            donorRecordId: donor._id,
            customerName: name,
            customerMobile: donor.mobile,
            customerEmail: email,
            subtotal: cart.subtotal,
            shippingCharge,
            total,
            shippingRuleSnapshot: {
              flatCharge: settings.flatShippingCharge,
              freeAbove: settings.freeShippingAbove,
            },
            shippingAddress: { street, city, state, pincode, country: "India" },
            customerNote: customerNote ? String(customerNote).slice(0, 500).trim() : undefined,
            razorpayOrderId: rzpOrder.id,
            paymentAccount: razorpay.account.name,
            statusHistory: [historyEntry("placed", "Order created")],
            createdAt: now,
            updatedAt: now,
          },
          { client }
        );
        await insertOrderItems(client, created._id, cart.items);
        return created;
      });

      res.status(200).json({
        success: true,
        orderNumber: order.orderNumber,
        orderId: order._id,
        razorpayOrderId: rzpOrder.id,
        key: razorpay.account.key_id,
        amount: Math.round(total * 100),
        subtotal: cart.subtotal,
        shippingCharge,
        total,
        customer: { name, mobile: donor.mobile, email: order.customerEmail },
      });
    } catch (err) {
      console.error("shopOrder.createOrder error:", err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: "Could not start checkout. Please try again." });
    }
  },

  // Browser verify and the Razorpay webhook may both confirm; confirmShopOrderPaid makes that safe.
  verifyPayment: async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ success: false, message: "Payment details missing." });
      }

      const [order] = await selectRows(
        shopOrders,
        { razorpayOrderId: queryValue(razorpay_order_id, "razorpayOrderId", "shopOrder") },
        'razorpay_order_id COLLATE "C" NULLS FIRST, id',
        { limit: 1 }
      );
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });
      if (req.donor && String(order.donorRecordId) !== String(req.donor.donorId)) {
        return res.status(403).json({ success: false, message: "This order belongs to another account." });
      }

      const created = createRazorpayInstance(order.paymentAccount);
      const keySecret = created && created.account ? created.account.key_secret : null;
      if (!keySecret) return res.status(500).json({ success: false, message: "Payments aren't configured." });

      const expected = crypto
        .createHmac("sha256", keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      if (expected !== razorpay_signature) {
        return res.status(400).json({ success: false, message: "Invalid payment signature." });
      }

      const result = await confirmShopOrderPaid({
        orderId: order._id,
        paymentId: razorpay_payment_id,
      });

      if (result.ok && result.order && !result.skipped) {
        setImmediate(() => sendOrderWhatsApp(result.order));
      }

      res.status(200).json({
        success: true,
        message: "Payment confirmed.",
        orderNumber: order.orderNumber,
        needsAttention: !!(result.shortfall && result.shortfall.length),
      });
    } catch (err) {
      console.error("shopOrder.verifyPayment error:", err);
      res.status(500).json({ success: false, message: "Could not verify payment." });
    }
  },

  myOrders: async (req, res) => {
    try {
      const donorId = idFilterValue(req.donor.donorId, "shopOrder", "donorRecordId");
      const orders = await selectRows(shopOrders, { donorRecordId: donorId }, `${ms("created_at")} DESC, id`, {
        lean: true,
      });
      await attachItems(orders, undefined, { lean: true });
      res.status(200).json({
        success: true,
        orders: orders.map((o) => {
          const out = {};
          for (const k of [
            "_id",
            "orderNumber",
            "items",
            "subtotal",
            "shippingCharge",
            "total",
            "paymentStatus",
            "fulfilmentStatus",
            "tracking",
            "createdAt",
            "shippingAddress",
          ])
            if (o[k] !== undefined) out[k] = o[k];
          return out;
        }),
      });
    } catch (err) {
      console.error("shopOrder.myOrders error:", err);
      res.status(500).json({ success: false, message: "Could not load your orders." });
    }
  },

  // Ownership is part of the query, so a guessed order number returns nothing.
  getMyOrder: async (req, res) => {
    try {
      const donorId = idFilterValue(req.donor.donorId, "shopOrder", "donorRecordId");
      const order = req.params.orderNumber.includes("\0")
        ? null
        : await loadOrder({ orderNumber: req.params.orderNumber, donorRecordId: donorId }, undefined, { lean: true });
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });
      res.status(200).json({ success: true, order });
    } catch (err) {
      console.error("shopOrder.getMyOrder error:", err);
      res.status(500).json({ success: false, message: "Could not load this order." });
    }
  },

  adminListOrders: async (req, res) => {
    try {
      const { paymentStatus, fulfilmentStatus, search, needsAttention, page = 1, limit = 30 } = req.query;
      const filter = {};
      if (paymentStatus && paymentStatus !== "all")
        filter.paymentStatus = queryValue(paymentStatus, "paymentStatus", "shopOrder");
      if (fulfilmentStatus && fulfilmentStatus !== "all")
        filter.fulfilmentStatus = queryValue(fulfilmentStatus, "fulfilmentStatus", "shopOrder");
      if (String(needsAttention) === "true") filter.needsAttention = true;
      const matcher = search && String(search).trim() ? searchMatcher(String(search).trim()) : null;

      const pageNum = Math.max(1, Number(page) || 1);
      const perPage = Math.min(100, Math.max(1, Number(limit) || 30));
      const skip = wholeNumber((pageNum - 1) * perPage);
      const order = `${ms("created_at")} DESC, id`;

      let orders;
      let total;
      if (matcher) {
        const params = [];
        const where = shopOrders.buildWhere(filter, params).sql;
        const all = await many(
          `SELECT id, order_number, customer_mobile, customer_name FROM shop_orders${where ? ` WHERE ${where}` : ""} ORDER BY ${order}`,
          params
        );
        const hits = all.filter((r) => matcher([r.order_number, r.customer_mobile, r.customer_name])).map((r) => r.id);
        total = hits.length;
        const pageIds = hits.slice(skip, skip + wholeNumber(perPage));
        const found = pageIds.length
          ? await selectRows(shopOrders, { _id: { $in: pageIds } }, "id", { lean: true })
          : [];
        const byId = new Map(found.map((o) => [o._id, o]));
        orders = pageIds.map((id) => byId.get(id));
      } else {
        orders = await selectRows(shopOrders, filter, order, { limit: wholeNumber(perPage), offset: skip, lean: true });
        total = await shopOrders.count(filter);
      }
      const stats = await many(
        "SELECT coalesce(sum(total), 0) AS revenue, count(*) AS count FROM shop_orders WHERE payment_status = 'paid'"
      );
      await attachItems(orders, undefined, { lean: true });

      res.status(200).json({
        success: true,
        orders,
        pagination: { page: pageNum, limit: perPage, total, pages: Math.ceil(total / perPage) },
        stats: { paidRevenue: Number(stats[0]?.revenue) || 0, paidOrders: Number(stats[0]?.count) || 0 },
      });
    } catch (err) {
      console.error("shopOrder.adminListOrders error:", err);
      res.status(500).json({ success: false, message: "Could not load orders." });
    }
  },

  // Cancelling a paid order returns its stock. As before, the stock is restored before the order is saved, so a
  // save that then fails leaves the restore in place.
  adminUpdateOrder: async (req, res) => {
    try {
      const { fulfilmentStatus, tracking, adminNote, note, needsAttention, paymentStatus } = req.body || {};
      const id = castIdParam(req.params.id, "shopOrder");
      const order = await loadOrder({ _id: id });
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });

      const patch = {};
      const history = [...(order.statusHistory || [])];
      let currentFulfilment = order.fulfilmentStatus;

      if (fulfilmentStatus && fulfilmentStatus !== order.fulfilmentStatus) {
        const valid = ["placed", "packed", "shipped", "delivered", "cancelled"];
        if (!valid.includes(fulfilmentStatus)) {
          return res.status(400).json({ success: false, message: "Unknown fulfilment status." });
        }

        if (fulfilmentStatus === "cancelled" && order.stockCommitted) {
          for (const item of order.items) await restoreStock({ query }, item);
          patch.stockCommitted = false;
          history.push(
            historyEntry("stock_restored", "Stock returned to inventory on cancellation", {
              byUserId: req.user.userId,
            })
          );
        }

        patch.fulfilmentStatus = fulfilmentStatus;
        currentFulfilment = fulfilmentStatus;
        history.push(historyEntry(fulfilmentStatus, note, { byUserId: req.user.userId }));
      }

      if (paymentStatus && ["pending", "paid", "failed", "refunded"].includes(paymentStatus)) {
        if (paymentStatus !== order.paymentStatus) patch.paymentStatus = paymentStatus;
        history.push(
          historyEntry(`payment_${paymentStatus}`, note || "Payment status set manually", {
            byUserId: req.user.userId,
          })
        );
      }

      if (tracking) {
        const newTracking = {
          courier: tracking.courier || order.tracking?.courier,
          trackingNumber: tracking.trackingNumber || order.tracking?.trackingNumber,
          url: tracking.url || order.tracking?.url,
        };
        if (!newTracking.courier && newTracking.trackingNumber) {
          newTracking.courier = trackingService.detectCourier(newTracking.trackingNumber) || undefined;
        }
        if (!newTracking.url && newTracking.courier && newTracking.trackingNumber) {
          newTracking.url =
            trackingService.buildTrackingUrl(newTracking.courier, newTracking.trackingNumber) || undefined;
        }
        const changed = {};
        for (const k of ["courier", "trackingNumber", "url"]) {
          const v = castString(newTracking[k], `tracking.${k}`);
          if (v !== undefined && v !== (order.tracking?.[k] ?? undefined)) changed[k] = v;
        }
        if (Object.keys(changed).length) patch.tracking = changed;
      }

      if (fulfilmentStatus === "shipped" && currentFulfilment === "shipped" && !order.shippedAt) {
        patch.shippedAt = new Date();
      }
      if (adminNote !== undefined) {
        const v = castString(adminNote, "adminNote");
        if ((v ?? null) !== (order.adminNote ?? null)) patch.adminNote = v;
      }
      if (needsAttention !== undefined && !!needsAttention !== !!order.needsAttention) {
        patch.needsAttention = !!needsAttention;
      }
      if (history.length !== (order.statusHistory || []).length) patch.statusHistory = checkedHistory(history);

      const saved = Object.keys(patch).length
        ? await shopOrders.updateById(order._id, { ...patch, updatedAt: new Date() })
        : order;
      saved.items = order.items;

      if (fulfilmentStatus === "shipped") {
        setImmediate(async () => {
          try {
            if (!isWhatsAppConfigured()) return;
            const trackingLine = saved.tracking?.trackingNumber
              ? `\nTracking: ${saved.tracking.courier || ""} ${saved.tracking.trackingNumber}`.trim()
              : "";
            await sendUtilityMessage(
              saved.customerMobile,
              `Hare Krishna ${saved.customerName}! Your order ${saved.orderNumber} has been shipped.${trackingLine}`
            );
          } catch (e) {
            console.warn("shop ship notification failed:", e && e.message ? e.message : e);
          }
        });
      }

      res.status(200).json({ success: true, message: "Order updated.", order: saved });
    } catch (err) {
      console.error("shopOrder.adminUpdateOrder error:", err);
      res.status(500).json({ success: false, message: "Could not update order." });
    }
  },
};

export { shopOrderController, confirmShopOrderPaid, sendOrderWhatsApp };
