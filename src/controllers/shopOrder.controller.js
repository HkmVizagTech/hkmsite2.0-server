const crypto = require("crypto");
const { productModel, resolvePurchasable } = require("../models/product.model");
const { shopOrderModel } = require("../models/shopOrder.model");
const { getShopSettings, calculateShipping } = require("../models/shopSettings.model");
const { donorModel } = require("../models/donor.model");
const { getNextSequence } = require("../utils/counter");

// Which Razorpay account the shop sells through. Per the temple's decision
// this is the SAME account that takes donations — but it is resolved through
// a named env var rather than hard-coded, because "shop money and donation
// money share an account" is a business decision that can be reversed
// (separate trust, separate settlement) without touching this code.
//
// Crucially, sharing the ACCOUNT does not mean sharing the PIPELINE: a shop
// order never runs completeDonation(), never syncs to DCC, never gets an 80G
// receipt number, and never sends the donation receipt template. A book sale
// is not a donation and must never produce a donation receipt.
const SHOP_ACCOUNT = process.env.SHOP_RAZORPAY_ACCOUNT || "donations";

function resolveShopRazorpay() {
  const { createRazorpayInstance } = require("./payment.controller");
  return createRazorpayInstance(SHOP_ACCOUNT) || createRazorpayInstance("default");
}

async function generateOrderNumber() {
  const seq = await getNextSequence("shopOrder");
  return `HKMS-${new Date().getFullYear()}-${String(seq).padStart(5, "0")}`;
}

// Rebuilds the cart from the database. The browser sends only product IDs,
// variant IDs and quantities — never prices. Every rupee in an order is
// computed here from the live catalog, so a tampered cart payload can't buy
// a ₹2000 deity dress for ₹1.
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
      problems.push({ productId: raw.productId, reason: "invalid_quantity", message: "Choose a quantity between 1 and 99." });
      continue;
    }

    const product = await productModel.findById(raw.productId).lean();
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

// Marks an order paid and commits its stock — EXACTLY ONCE, no matter how
// many times it's called. Both the browser's verify call and Razorpay's
// webhook confirm the same payment, and they routinely race; the atomic
// findOneAndUpdate guarded on paymentStatus:"pending" is what makes the
// loser of that race a harmless no-op instead of a double stock decrement.
async function confirmShopOrderPaid({ orderId, razorpayOrderId, paymentId }) {
  const filter = { paymentStatus: "pending" };
  if (orderId) filter._id = orderId;
  else if (razorpayOrderId) filter.razorpayOrderId = razorpayOrderId;
  else return { ok: false, reason: "no_identifier" };

  const order = await shopOrderModel.findOneAndUpdate(
    filter,
    {
      paymentStatus: "paid",
      paidAt: new Date(),
      razorpayPaymentId: paymentId,
      $push: { statusHistory: { status: "paid", note: "Payment confirmed", at: new Date() } },
    },
    { new: true }
  );

  if (!order) {
    // Either it doesn't exist, or another path already confirmed it.
    const existing = await shopOrderModel.findOne(orderId ? { _id: orderId } : { razorpayOrderId });
    if (existing) return { ok: true, skipped: true, reason: "already_confirmed", order: existing };
    return { ok: false, reason: "order_not_found" };
  }

  // ---- Commit stock ----
  // Each decrement is a single conditional update: it only succeeds if the
  // shelf still holds enough. That condition is the entire oversell
  // protection — two simultaneous buyers of the last unit cannot both pass.
  const shortfall = [];
  for (const item of order.items) {
    let updated;
    if (item.variantId) {
      updated = await productModel.findOneAndUpdate(
        {
          _id: item.productId,
          variants: { $elemMatch: { _id: item.variantId, stock: { $gte: item.quantity } } },
        },
        { $inc: { "variants.$.stock": -item.quantity } },
        { new: true }
      );
    } else {
      updated = await productModel.findOneAndUpdate(
        { _id: item.productId, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity } },
        { new: true }
      );
    }

    if (!updated) {
      // The money is already taken, so refusing the order here would be the
      // worst outcome. Record what's missing and flag it for staff, who can
      // restock, part-ship or refund — a human decision, not a silent one.
      const current = await productModel.findById(item.productId).lean();
      const available = current
        ? item.variantId
          ? (current.variants || []).find((v) => String(v._id) === String(item.variantId))?.stock || 0
          : current.stock || 0
        : 0;
      shortfall.push({
        productId: item.productId,
        productName: item.productName,
        variantLabel: item.variantLabel,
        requested: item.quantity,
        available,
      });
    }
  }

  order.stockCommitted = true;
  if (shortfall.length) {
    order.stockShortfall = shortfall;
    order.needsAttention = true;
    order.statusHistory.push({
      status: "stock_shortfall",
      note: `Paid, but ${shortfall.length} item(s) could not be fully reserved. Needs staff review.`,
      at: new Date(),
    });
  }
  await order.save();

  return { ok: true, order, shortfall };
}

// WhatsApp order confirmation. Deliberately fire-and-forget and fully
// swallowed: a messaging failure must never turn a successful, paid order
// into an error for the devotee. Uses the generic utility template, NOT the
// donation receipt template.
async function sendOrderWhatsApp(order) {
  try {
    const { isWhatsAppConfigured, sendUtilityMessage } = require("../services/whatsapp.service");
    if (!isWhatsAppConfigured()) return;

    const lines = order.items
      .map((i) => `• ${i.productName}${i.variantLabel ? ` (${i.variantLabel})` : ""} × ${i.quantity}`)
      .join("\n");
    const message =
      `Hare Krishna ${order.customerName}! Your order ${order.orderNumber} is confirmed.\n\n${lines}\n\n` +
      `Total paid: ₹${order.total.toLocaleString("en-IN")}\n` +
      `We'll message you again when it ships. Thank you for your support.`;

    await sendUtilityMessage(order.customerMobile, message);
    await shopOrderModel.findByIdAndUpdate(order._id, { whatsappConfirmationSentAt: new Date() });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn("shopOrder WhatsApp confirmation failed:", message);
    await shopOrderModel
      .findByIdAndUpdate(order._id, { whatsappConfirmationError: message.slice(0, 300) })
      .catch(() => {});
  }
}

const shopOrderController = {
  // POST /shop/cart/quote — public. Re-prices a cart against the live
  // catalog so the cart page shows authoritative prices, real stock and the
  // actual shipping charge, instead of whatever was cached in the browser
  // when the item was added days ago.
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

  // POST /shop/orders — customer (donor session required). Creates the
  // order in "pending" and hands back a Razorpay order to pay against.
  // Stock is checked here but NOT decremented — see confirmShopOrderPaid.
  createOrder: async (req, res) => {
    try {
      const settings = await getShopSettings();
      if (!settings.shopEnabled) {
        return res.status(503).json({ success: false, message: "The shop is temporarily closed. Please try again later." });
      }

      const donor = await donorModel.findById(req.donor.donorId).lean();
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
        return res.status(500).json({ success: false, message: "Payments aren't configured. Please contact the temple." });
      }

      const orderNumber = await generateOrderNumber();
      const rzpOrder = await razorpay.instance.orders.create({
        amount: Math.round(total * 100),
        currency: "INR",
        receipt: orderNumber,
        payment_capture: 1,
        // Tagged so a shop payment is identifiable in the Razorpay dashboard
        // at a glance, even though it shares an account with donations.
        notes: { type: "shop_order", orderNumber, mobile: donor.mobile },
      });

      const order = await shopOrderModel.create({
        orderNumber,
        donorRecordId: donor._id,
        customerName: name,
        customerMobile: donor.mobile,
        customerEmail: customerEmail || donor.email,
        items: cart.items,
        subtotal: cart.subtotal,
        shippingCharge,
        total,
        shippingRuleSnapshot: {
          flatCharge: settings.flatShippingCharge,
          freeAbove: settings.freeShippingAbove,
        },
        shippingAddress: { street, city, state, pincode, country: "India" },
        customerNote: customerNote ? String(customerNote).slice(0, 500) : undefined,
        razorpayOrderId: rzpOrder.id,
        paymentAccount: razorpay.account.name,
        statusHistory: [{ status: "placed", note: "Order created", at: new Date() }],
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

  // POST /shop/orders/verify — called by the browser right after Razorpay's
  // success callback. The webhook is the safety net for when the devotee
  // closes the tab (very common with UPI app switches), so this and the
  // webhook are both allowed to confirm, and confirmShopOrderPaid makes
  // that safe.
  verifyPayment: async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ success: false, message: "Payment details missing." });
      }

      const order = await shopOrderModel.findOne({ razorpayOrderId: razorpay_order_id });
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });
      // A logged-in customer can only verify their own order.
      if (req.donor && String(order.donorRecordId) !== String(req.donor.donorId)) {
        return res.status(403).json({ success: false, message: "This order belongs to another account." });
      }

      const { createRazorpayInstance } = require("./payment.controller");
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

  // GET /shop/my-orders — the customer's own order history.
  myOrders: async (req, res) => {
    try {
      const orders = await shopOrderModel
        .find({ donorRecordId: req.donor.donorId })
        .sort({ createdAt: -1 })
        .select("orderNumber items subtotal shippingCharge total paymentStatus fulfilmentStatus tracking createdAt shippingAddress")
        .lean();
      res.status(200).json({ success: true, orders });
    } catch (err) {
      console.error("shopOrder.myOrders error:", err);
      res.status(500).json({ success: false, message: "Could not load your orders." });
    }
  },

  // GET /shop/my-orders/:orderNumber — ownership enforced by query, so a
  // guessed order number returns nothing rather than someone else's address.
  getMyOrder: async (req, res) => {
    try {
      const order = await shopOrderModel
        .findOne({ orderNumber: req.params.orderNumber, donorRecordId: req.donor.donorId })
        .lean();
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });
      res.status(200).json({ success: true, order });
    } catch (err) {
      console.error("shopOrder.getMyOrder error:", err);
      res.status(500).json({ success: false, message: "Could not load this order." });
    }
  },

  // ---------------------------------------------------------------------
  // ADMIN
  // ---------------------------------------------------------------------
  adminListOrders: async (req, res) => {
    try {
      const { paymentStatus, fulfilmentStatus, search, needsAttention, page = 1, limit = 30 } = req.query;
      const filter = {};
      if (paymentStatus && paymentStatus !== "all") filter.paymentStatus = paymentStatus;
      if (fulfilmentStatus && fulfilmentStatus !== "all") filter.fulfilmentStatus = fulfilmentStatus;
      if (String(needsAttention) === "true") filter.needsAttention = true;
      if (search && String(search).trim()) {
        const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ orderNumber: rx }, { customerMobile: rx }, { customerName: rx }];
      }

      const pageNum = Math.max(1, Number(page) || 1);
      const perPage = Math.min(100, Math.max(1, Number(limit) || 30));

      const [orders, total, stats] = await Promise.all([
        shopOrderModel.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * perPage).limit(perPage).lean(),
        shopOrderModel.countDocuments(filter),
        shopOrderModel.aggregate([
          { $match: { paymentStatus: "paid" } },
          { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } },
        ]),
      ]);

      res.status(200).json({
        success: true,
        orders,
        pagination: { page: pageNum, limit: perPage, total, pages: Math.ceil(total / perPage) },
        stats: { paidRevenue: stats[0]?.revenue || 0, paidOrders: stats[0]?.count || 0 },
      });
    } catch (err) {
      console.error("shopOrder.adminListOrders error:", err);
      res.status(500).json({ success: false, message: "Could not load orders." });
    }
  },

  // PATCH /shop-admin/orders/:id — fulfilment status, tracking and notes.
  // Cancelling a paid order puts its stock back on the shelf, but only if
  // that stock was actually committed and only once (guarded by
  // stockCommitted), so a double-cancel can't inflate inventory.
  adminUpdateOrder: async (req, res) => {
    try {
      const order = await shopOrderModel.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });

      const { fulfilmentStatus, tracking, adminNote, note, needsAttention, paymentStatus } = req.body || {};

      if (fulfilmentStatus && fulfilmentStatus !== order.fulfilmentStatus) {
        const valid = ["placed", "packed", "shipped", "delivered", "cancelled"];
        if (!valid.includes(fulfilmentStatus)) {
          return res.status(400).json({ success: false, message: "Unknown fulfilment status." });
        }

        if (fulfilmentStatus === "cancelled" && order.stockCommitted) {
          for (const item of order.items) {
            if (item.variantId) {
              await productModel.updateOne(
                { _id: item.productId, "variants._id": item.variantId },
                { $inc: { "variants.$.stock": item.quantity } }
              );
            } else {
              await productModel.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
            }
          }
          order.stockCommitted = false;
          order.statusHistory.push({
            status: "stock_restored",
            note: "Stock returned to inventory on cancellation",
            at: new Date(),
            byUserId: req.user.userId,
          });
        }

        order.fulfilmentStatus = fulfilmentStatus;
        order.statusHistory.push({
          status: fulfilmentStatus,
          note: note || undefined,
          at: new Date(),
          byUserId: req.user.userId,
        });
      }

      if (paymentStatus && ["pending", "paid", "failed", "refunded"].includes(paymentStatus)) {
        order.paymentStatus = paymentStatus;
        order.statusHistory.push({
          status: `payment_${paymentStatus}`,
          note: note || "Payment status set manually",
          at: new Date(),
          byUserId: req.user.userId,
        });
      }

      if (tracking) {
        // Fill the customer-facing tracking URL automatically from the
        // courier registry when the admin didn't paste one by hand, and
        // guess the courier from the number's format when they didn't pick
        // one. Both are conveniences only — an explicit admin value always
        // wins over an auto-built URL.
        const trackingService = require("../services/tracking.service");
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
        order.tracking = newTracking;
      }

      // Remember when the parcel actually left, so the auto-tracking job
      // knows how long to keep polling the courier for this order.
      if (fulfilmentStatus === "shipped" && order.fulfilmentStatus === "shipped" && !order.shippedAt) {
        order.shippedAt = new Date();
      }
      if (adminNote !== undefined) order.adminNote = adminNote;
      if (needsAttention !== undefined) order.needsAttention = !!needsAttention;

      await order.save();

      // Tell the customer when it ships — same fire-and-forget rules as the
      // confirmation message.
      if (fulfilmentStatus === "shipped") {
        setImmediate(async () => {
          try {
            const { isWhatsAppConfigured, sendUtilityMessage } = require("../services/whatsapp.service");
            if (!isWhatsAppConfigured()) return;
            const trackingLine = order.tracking?.trackingNumber
              ? `\nTracking: ${order.tracking.courier || ""} ${order.tracking.trackingNumber}`.trim()
              : "";
            await sendUtilityMessage(
              order.customerMobile,
              `Hare Krishna ${order.customerName}! Your order ${order.orderNumber} has been shipped.${trackingLine}`
            );
          } catch (e) {
            console.warn("shop ship notification failed:", e && e.message ? e.message : e);
          }
        });
      }

      res.status(200).json({ success: true, message: "Order updated.", order });
    } catch (err) {
      console.error("shopOrder.adminUpdateOrder error:", err);
      res.status(500).json({ success: false, message: "Could not update order." });
    }
  },
};

module.exports = { shopOrderController, confirmShopOrderPaid, sendOrderWhatsApp };
