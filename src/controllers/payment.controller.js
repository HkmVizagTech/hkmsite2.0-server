import Razorpay from "razorpay";
import crypto from "node:crypto";
import { donations, plans, shopOrders, festivalDonations, campaigners, templeDevotees } from "../db/tables.js";
import { query as sql } from "../db/pg.js";
import { castPaymentDonation, castPaymentDonationId } from "../domain/paymentCast.js";
import { sanitizeBannerImage } from "../services/pageBanner.service.js";
import { recordPaymentFailure, recordDowntime } from "../services/paymentFailure.service.js";

import {
  completeDonation,
  markDonationCompleted,
  runPostCompletionPipeline,
  handleSubscriptionCharged,
} from "../services/paymentCompletion.service.js";
import { confirmShopOrderPaid, sendOrderWhatsApp } from "./shopOrder.controller.js";
import { liveCheckDonationOrder } from "../services/liveOrderCheck.service.js";

const MIN_DONATION_AMOUNT = Math.max(1, Number(process.env.MIN_DONATION_AMOUNT) || 100);
const belowMinimum = (amount) => !amount || !Number.isFinite(Number(amount)) || Number(amount) < MIN_DONATION_AMOUNT;
const MIN_AMOUNT_MESSAGE = `The minimum donation is Rs. ${MIN_DONATION_AMOUNT}.`;

const RAZORPAY_ACCOUNTS = {
  default: {
    key_id: () => process.env.RAZORPAY_KEY_ID,
    key_secret: () => process.env.RAZORPAY_KEY_SECRET,
    webhook_secret: () => process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  donations: {
    key_id: () => process.env.RAZORPAY_DONATIONS_KEY_ID,
    key_secret: () => process.env.RAZORPAY_DONATIONS_KEY_SECRET,
    webhook_secret: () => process.env.RAZORPAY_DONATIONS_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  touchstone: {
    key_id: () => process.env.RAZORPAY_TOUCHSTONE_KEY_ID,
    key_secret: () => process.env.RAZORPAY_TOUCHSTONE_KEY_SECRET,
    webhook_secret: () => process.env.RAZORPAY_TOUCHSTONE_WEBHOOK_SECRET,
  },
  shop: {
    key_id: () => process.env.RAZORPAY_SHOP_KEY_ID,
    key_secret: () => process.env.RAZORPAY_SHOP_KEY_SECRET,
    webhook_secret: () => process.env.RAZORPAY_SHOP_WEBHOOK_SECRET,
  },
};

const normalizeAccount = (account) => (account && RAZORPAY_ACCOUNTS[account] ? account : "default");

const resolveAccount = (accountName) => {
  const name = normalizeAccount(accountName);
  const config = RAZORPAY_ACCOUNTS[name];
  return {
    name,
    key_id: config.key_id(),
    key_secret: config.key_secret(),
    webhook_secret: config.webhook_secret(),
  };
};

const createRazorpayInstance = (accountName) => {
  const account = resolveAccount(accountName);
  const { key_id, key_secret } = account;
  if (!key_id || !key_secret) return null;
  try {
    console.log("createRazorpayInstance:", account.name, key_id ? `${key_id.slice(0, 6)}...` : "not-set");
  } catch (e) {}
  return { account, instance: new Razorpay({ key_id, key_secret }) };
};

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const verifySignature = ({ orderId, paymentId, signature, keySecret }) => {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac("sha256", keySecret).update(body).digest("hex");
  return safeEqual(expected, signature);
};

// Processes a verified Razorpay webhook event in-process (called right after
// the 200 is sent to Razorpay).
async function processWebhookEventInline(event) {
  switch (event.event) {
    case "payment.captured": {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      if (!payment) break;
      const orderId = payment.order_id;
      if (!orderId) {
        console.log("payment.captured without an order (QR/direct UPI):", payment.id, payment.amount / 100);
        break;
      }
      const completedDonation = await completeDonation({ orderId, paymentId: payment.id });
      if (completedDonation) {
        console.log("Donation marked completed for order", orderId);
        break;
      }
      {
        const shopResult = await confirmShopOrderPaid({ razorpayOrderId: orderId, paymentId: payment.id });
        if (shopResult.ok && shopResult.order) {
          if (shopResult.skipped) {
            console.log("Shop order already confirmed for order", orderId);
          } else {
            console.log("Shop order marked paid:", shopResult.order.orderNumber);
            setImmediate(() => sendOrderWhatsApp(shopResult.order));
          }
        } else {
          // An event registration fee (events with payment switched on): marks the registration paid even when
          // the visitor closed the page before the form's own confirmation call ran.
          const { markRegistrationPaidByOrder } = await import("./registration.controller.js");
          const reg = await markRegistrationPaidByOrder({ orderId, paymentId: payment.id });
          if (reg) console.log("Event registration paid for order", orderId);
          else console.warn("No donation, shop order or event registration found for order:", orderId);
        }
      }
      break;
    }
    case "payment.failed": {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      if (!payment) break;
      const orderId = payment.order_id;
      if (!orderId) break;
      {
        const shopOrder = await shopOrders.findOne({ razorpayOrderId: orderId });
        if (shopOrder) {
          if (shopOrder.paymentStatus === "pending") {
            const entry = {
              status: "payment_failed",
              note: "Razorpay reported payment.failed",
              at: new Date().toISOString(),
            };
            const r = await sql(
              `UPDATE shop_orders SET payment_status = 'failed', status_history = status_history || $2::jsonb, updated_at = now()
               WHERE id = $1 AND payment_status = 'pending'`,
              [shopOrder._id, JSON.stringify([entry])]
            );
            if (r.rowCount) console.log("Shop order marked failed:", shopOrder.orderNumber);
          }
          break;
        }
      }
      const donation = await donations.findOne({ razorpayOrderId: orderId }, { sort: { createdAt: 1, _id: 1 } });
      // Keep Razorpay's reason for every failed attempt (bank declined, UPI
      // request expired, cancelled by the donor…), whatever happens next.
      if (donation) {
        try {
          await recordPaymentFailure(donation._id, payment);
        } catch (e) {
          console.warn("recordPaymentFailure failed:", e && e.message ? e.message : e);
        }
      }
      if (donation && donation.status === "pending") {
        try {
          const created = createRazorpayInstance(donation.paymentAccount);
          if (created) {
            const payments = await created.instance.orders.fetchPayments(orderId);
            const captured = (payments.items || []).find((p) => p.status === "captured");
            if (captured) {
              await completeDonation({ orderId, paymentId: captured.id });
              console.log("payment.failed webhook but found captured payment for order", orderId);
            } else {
              await donations.updateById(donation._id, { status: "failed", razorpayPaymentId: payment.id });
              console.log("Donation marked failed for order", orderId);
            }
          }
        } catch (rzpErr) {
          // If Razorpay check fails, still mark as failed based on the webhook event
          await donations.updateById(donation._id, { status: "failed", razorpayPaymentId: payment.id });
          console.log("Donation marked failed (Razorpay check failed) for order", orderId);
        }
      }
      break;
    }
    case "payment.downtime.started":
    case "payment.downtime.updated":
    case "payment.downtime.resolved": {
      await recordDowntime(event.event, event.payload);
      break;
    }
    case "subscription.activated": {
      const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
      if (sub)
        // Only while the sign-up record is still pending and unpaid: Razorpay can send this after the first
        // charge was confirmed, and overwriting a completed record cloned a duplicate on the next charge.
        await donations.updateOne(
          { subscriptionId: sub.id ?? null, status: "pending", razorpayPaymentId: { $in: [null, ""] } },
          { status: "active" },
          { sort: { createdAt: 1, _id: 1 } }
        );
      break;
    }
    case "subscription.charged": {
      const result = await handleSubscriptionCharged(event.payload);
      if (result.ok && !result.skipped) {
        console.log("subscription.charged: recurring donation completed", result.donationId);
      } else if (result.skipped) {
        console.log("subscription.charged: skipped —", result.reason);
      } else {
        console.warn("subscription.charged: could not process —", result.reason);
      }
      break;
    }
    case "subscription.cancelled": {
      const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
      if (sub)
        await donations.updateMany(
          { subscriptionId: sub.id ?? null, isRecurring: true, status: { $nin: ["completed", "cancelled"] } },
          { status: "cancelled" }
        );
      break;
    }
    case "subscription.completed": {
      const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
      if (sub)
        await donations.updateOne(
          { subscriptionId: sub.id ?? null, isRecurring: true, status: "active" },
          { status: "completed" },
          { sort: { createdAt: 1, _id: 1 } }
        );
      break;
    }
    default:
      console.log("Unhandled event:", event.event);
  }
}

const paymentController = {
  createOrder: async (req, res) => {
    try {
      const {
        name,
        email,
        mobile,
        amount,
        certificate,
        panNumber,
        mahaprasadam,
        prasadamAddress,
        sourcePage,
        sevakName,
        sevaDate,
        dob,
        sevaName,
        legacySevaId,
        message,
      } = req.body;

      if (belowMinimum(amount)) {
        return res.status(400).send(MIN_AMOUNT_MESSAGE);
      }

      const razorpay = createRazorpayInstance(req.body.account);
      if (!razorpay) return res.status(500).json({ message: "Razorpay keys not configured on server" });
      const { account, instance } = razorpay;

      const options = {
        amount: Math.round(Number(amount) * 100),
        currency: "INR",
        receipt: `receipt_${Date.now()}`,
        payment_capture: 1,
        notes: {
          sourcePage: sourcePage || "",
          festivalSlug: req.body.festivalSlug || "",
          sevaName: sevaName || "",
          legacySevaId: legacySevaId ? String(legacySevaId) : "",
          campaignerSlug: req.body.campaignerSlug || "",
        },
      };

      const order = await instance.orders.create(options);

      let resolvedFestivalId = req.body.festivalId;
      if (!resolvedFestivalId && req.body.festivalSlug) {
        try {
          // Mongoose threw a CastError for an object/array slug here (swallowed below); never run it as a query.
          if (typeof req.body.festivalSlug === "object") throw new Error("festivalSlug is not a string");
          const fest = await festivalDonations.findOne(
            { slug: String(req.body.festivalSlug) },
            { fields: ["_id"], sort: { _id: 1 } }
          );
          if (fest) resolvedFestivalId = fest._id;
        } catch (err) {
          console.warn("Could not resolve festivalSlug to festivalId", req.body.festivalSlug, err);
        }
      }

      const donationInput = {
        donorName: name || req.body.donorName || "Anonymous",
        donorEmail: email || req.body.donorEmail,
        donorMobile: mobile || req.body.donorMobile,
        amount,
        type: req.body.type || (sourcePage === "donations" ? "Donation" : undefined),
        sourcePage,
        sevaName,
        sevaSlug: req.body.sevaSlug ? String(req.body.sevaSlug).slice(0, 80) : undefined,
        // Page hero banner, used as the pending-payment reminder's header image.
        bannerImage: sanitizeBannerImage(req.body.bannerImage),
        legacySevaId,
        message: message || undefined,
        paymentAccount: account.name,
        panNumber: panNumber || req.body.panNumber,
        certificate: certificate || req.body.certificate,
        sevakName: sevakName || req.body.sevakName || undefined,
        sevaDate: sevaDate || req.body.sevaDate || undefined,
        dob: dob || req.body.dob || undefined,
        wantPrasadam: mahaprasadam || req.body.wantPrasadam,
        prasadamAddress: prasadamAddress || req.body.prasadamAddress,
        festivalSlug: req.body.festivalSlug || undefined,
        campaignerSlug: req.body.campaignerSlug || undefined,
        dccEnrolledById: await (async () => {
          if (!req.body.campaignerSlug) return undefined;
          try {
            const camp = await campaigners.findOne(
              { slug: String(req.body.campaignerSlug), status: "active" },
              { sort: { _id: 1 }, lean: true }
            );
            const devotee = camp?.referredByDevotee
              ? await templeDevotees.findById(camp.referredByDevotee, { fields: ["dccEnrolledById"], lean: true })
              : null;
            const id = devotee?.dccEnrolledById;
            return Number.isFinite(Number(id)) && id != null ? Number(id) : undefined;
          } catch (e) {
            console.warn("campaigner devotee lookup failed:", e.message);
            return undefined;
          }
        })(),
        festivalId: resolvedFestivalId,
        razorpayOrderId: order.id,
        status: "pending",
        utm:
          req.body.utm && typeof req.body.utm === "object"
            ? {
                source: String(req.body.utm.source || "").slice(0, 100),
                medium: String(req.body.utm.medium || "").slice(0, 100),
                campaign: String(req.body.utm.campaign || "").slice(0, 100),
                content: String(req.body.utm.content || "").slice(0, 100),
                term: String(req.body.utm.term || "").slice(0, 100),
              }
            : undefined,
        metaEventId: req.body.metaEventId ? String(req.body.metaEventId).slice(0, 100) : undefined,
        metaFbp: req.body.metaFbp ? String(req.body.metaFbp).slice(0, 200) : undefined,
        metaFbc: req.body.metaFbc ? String(req.body.metaFbc).slice(0, 200) : undefined,
        metaClientIp:
          (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || undefined,
        metaUserAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]).slice(0, 400) : undefined,
      };
      const donation = await donations.insert(castPaymentDonation(donationInput));

      return res.status(200).json({ orderId: order.id, key: account.key_id, donationId: donation._id });
    } catch (err) {
      try {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        console.error("createOrder error", serialized);
      } catch (e) {
        console.error("createOrder error", err && err.stack ? err.stack : err);
      }
      let errStr = "";
      try {
        errStr = JSON.stringify(err, Object.getOwnPropertyNames(err));
      } catch (e) {
        errStr = String(err);
      }
      const razorpayStatus = err && err.statusCode ? err.statusCode : undefined;
      const razorpayBody = err && err.error ? err.error : undefined;
      return res.status(500).json({
        message: "Failed to create order",
        error: err && err.message ? err.message : errStr,
        razorpayStatus,
        razorpayBody,
      });
    }
  },

  createSubscription: async (req, res) => {
    try {
      const { name, email, mobile, amount, certificate, panNumber, sourcePage, sevaName, sevaUnitLabel } = req.body;

      if (belowMinimum(amount)) {
        return res.status(400).send(MIN_AMOUNT_MESSAGE);
      }

      const razorpay = createRazorpayInstance(req.body.account);
      if (!razorpay) return res.status(500).json({ message: "Razorpay keys not configured on server" });
      const { account, instance } = razorpay;

      const amountPaise = Math.round(Number(amount) * 100);
      const totalCount = Number(process.env.SUBSCRIPTION_TOTAL_COUNT || 120);

      let planId;
      const existingPlan = await plans.findOne({ amount: Number(amount), account: account.name });
      if (existingPlan) {
        planId = existingPlan.planId;
      } else {
        const newPlan = await instance.plans.create({
          period: "monthly",
          interval: 1,
          item: {
            name: String(sevaName || "Monthly Seva").slice(0, 250),
            amount: amountPaise,
            currency: "INR",
          },
          notes: { sevaName: sevaName || "", sourcePage: sourcePage || "" },
        });
        planId = newPlan.id;
        await plans.insert({ amount: Number(amount), account: account.name, planId });
      }

      const subscription = await instance.subscriptions.create({
        plan_id: planId,
        total_count: totalCount,
        quantity: 1,
        customer_notify: 0,
        notes: {
          sourcePage: sourcePage || "",
          sevaName: sevaName || "",
          sevaUnitLabel: sevaUnitLabel || "",
        },
      });

      // 3) A pending donation record for the first charge, flagged recurring.
      const donationInput = {
        donorName: name || req.body.donorName || "Anonymous",
        donorEmail: email || req.body.donorEmail,
        donorMobile: mobile || req.body.donorMobile,
        amount,
        type: req.body.type,
        sourcePage,
        sevaName,
        paymentAccount: account.name,
        panNumber: panNumber || req.body.panNumber,
        certificate: certificate || req.body.certificate,
        subscriptionId: subscription.id,
        isRecurring: true,
        status: "pending",
        campaignerSlug: req.body.campaignerSlug || undefined,
        utm:
          req.body.utm && typeof req.body.utm === "object"
            ? {
                source: String(req.body.utm.source || "").slice(0, 100),
                medium: String(req.body.utm.medium || "").slice(0, 100),
                campaign: String(req.body.utm.campaign || "").slice(0, 100),
                content: String(req.body.utm.content || "").slice(0, 100),
                term: String(req.body.utm.term || "").slice(0, 100),
              }
            : undefined,
      };
      const donation = await donations.insert(castPaymentDonation(donationInput));

      return res.status(200).json({
        subscriptionId: subscription.id,
        key: account.key_id,
        donationId: donation._id,
      });
    } catch (err) {
      let errStr = "";
      try {
        errStr = JSON.stringify(err, Object.getOwnPropertyNames(err));
      } catch (e) {
        errStr = String(err);
      }
      console.error("createSubscription error", errStr);
      const razorpayStatus = err && err.statusCode ? err.statusCode : undefined;
      const razorpayBody = err && err.error ? err.error : undefined;
      return res.status(500).json({
        message: "Failed to create subscription",
        error: err && err.message ? err.message : errStr,
        razorpayStatus,
        razorpayBody,
      });
    }
  },

  // SECURITY: the Razorpay signature only proves that the order (or subscription) and the payment belong
  // together, not that they belong to the donation being completed (see the upstream fix 3750026).
  verifyPayment: async (req, res) => {
    try {
      // Plain strings only; anything else is treated as missing.
      const str = (v) => (typeof v === "string" ? v.trim() : "");
      const orderId = str(req.body.razorpay_order_id);
      const paymentId = str(req.body.razorpay_payment_id);
      const signature = str(req.body.razorpay_signature);
      const subscriptionId = str(req.body.razorpay_subscription_id);
      const rawDonationId = req.body.donationId;
      if (
        rawDonationId != null &&
        rawDonationId !== "" &&
        !(typeof rawDonationId === "string" && /^[0-9a-f]{24}$/i.test(rawDonationId))
      ) {
        return res.status(400).json({ message: "Invalid donation reference" });
      }
      const donationId = rawDonationId || null;

      if (!paymentId || !signature) {
        return res.status(400).json({ message: "Payment verification details missing" });
      }
      const isSubscription = !!subscriptionId;
      if (!isSubscription && !orderId) {
        return res.status(400).json({ message: "Payment verification details missing" });
      }

      const query = donationId
        ? { _id: castPaymentDonationId(donationId) }
        : isSubscription
          ? { subscriptionId }
          : { razorpayOrderId: orderId };
      const donation = await donations.findOne(query, { sort: { createdAt: 1, _id: 1 } });
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      // The payment must be for THIS donation's own order / subscription.
      const belongs = isSubscription
        ? !!donation.subscriptionId && donation.subscriptionId === subscriptionId
        : !!donation.razorpayOrderId && donation.razorpayOrderId === orderId;
      if (!belongs) {
        console.warn(
          `verifyPayment: ${isSubscription ? "subscription" : "order"} ${isSubscription ? subscriptionId : orderId} ` +
            `does not belong to donation ${String(donation._id)} - rejected`
        );
        return res.status(400).json({ message: "This payment does not belong to this donation" });
      }

      const account = resolveAccount(donation.paymentAccount);
      if (!account.key_secret) return res.status(500).json({ message: "Razorpay keys not configured on server" });

      // Subscriptions sign as payment_id|subscription_id; one-time orders as order_id|payment_id.
      const signedBody = isSubscription ? `${paymentId}|${subscriptionId}` : `${orderId}|${paymentId}`;
      const expected = crypto.createHmac("sha256", account.key_secret).update(signedBody).digest("hex");
      if (!safeEqual(expected, signature)) {
        return res.status(400).json({ message: "Invalid payment signature" });
      }

      // One payment completes one donation. A monthly charge the subscription.charged webhook already
      // recorded on its own copy of this subscription is the donor's own payment: answer with that record.
      const other = await donations.findOne({ razorpayPaymentId: paymentId, _id: { $ne: donation._id } });
      if (other) {
        if (isSubscription && other.subscriptionId === subscriptionId) {
          return res.status(200).json({ message: "Payment verified", donation: other });
        }
        console.warn(
          `verifyPayment: payment ${paymentId} already recorded on donation ${String(other._id)} - rejected for ${String(donation._id)}`
        );
        return res.status(409).json({ message: "This payment is already recorded against another donation" });
      }

      const updated = await markDonationCompleted({
        donationId: donation._id,
        orderId: isSubscription ? undefined : orderId,
        paymentId,
      });

      res.status(200).json({ message: "Payment verified", donation: updated });

      if (updated) {
        setImmediate(() => {
          runPostCompletionPipeline(updated._id, paymentId).catch((err) => {
            console.error(
              "Background pipeline error for donation",
              String(updated._id),
              err && err.message ? err.message : err
            );
          });
        });
      }
      return;
    } catch (err) {
      console.error("verifyPayment error", err && err.stack ? err.stack : err);
      return res.status(500).json({ message: "Failed to verify payment" });
    }
  },

  webhookFor: (accountName) => async (req, res) => {
    try {
      const signature = req.headers["x-razorpay-signature"];
      if (!signature) return res.status(400).send("Signature missing");

      const account = resolveAccount(accountName);
      if (!account.webhook_secret) {
        console.warn(`Webhook received for "${accountName}" but no webhook secret is configured for it.`);
        return res.status(500).send(`No webhook secret configured for account "${accountName}"`);
      }

      const body = req.body && req.body.toString ? req.body.toString() : JSON.stringify(req.body || {});
      const expected = crypto.createHmac("sha256", account.webhook_secret).update(body).digest("hex");
      if (!safeEqual(expected, signature)) {
        console.warn(`Invalid webhook signature for account "${accountName}"`);
        return res.status(400).send("Invalid signature");
      }

      const event = JSON.parse(body);
      console.log(`Webhook Event [${accountName}]:`, event.event);

      res.status(200).send("Webhook received");

      setImmediate(async () => {
        try {
          await processWebhookEventInline(event);
        } catch (procErr) {
          console.error("Inline webhook processing error:", procErr && procErr.stack ? procErr.stack : procErr);
        }
      });
    } catch (error) {
      console.error("webhook error", error && error.stack ? error.stack : error);
      if (!res.headersSent) return res.status(500).send("Webhook error");
    }
  },
  reconcile: async (req, res) => {
    try {
      const donation = await donations.findById(castPaymentDonationId(req.params.donationId));
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      if (!donation.razorpayOrderId) {
        return res.status(400).json({ message: "This donation has no Razorpay order ID to check." });
      }
      if (donation.status === "completed") {
        return res.status(200).json({ message: "Already marked completed.", status: donation.status });
      }

      const created = createRazorpayInstance(donation.paymentAccount);
      if (!created) {
        return res
          .status(500)
          .json({ message: `Razorpay is not configured for account "${donation.paymentAccount || "default"}".` });
      }

      const payments = await created.instance.orders.fetchPayments(donation.razorpayOrderId);
      const captured = (payments.items || []).find((p) => p.status === "captured");

      if (!captured) {
        const statuses = (payments.items || []).map((p) => p.status);
        return res.status(200).json({
          message: statuses.length
            ? `Razorpay shows no captured payment for this order (found: ${statuses.join(", ")}). Leaving as pending.`
            : "Razorpay has no payment attempts at all for this order — the donor likely never completed checkout. Leaving as pending.",
          razorpayPayments: payments.items,
        });
      }

      const completed = await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
      return res.status(200).json({
        message: `Razorpay confirms this payment was captured (₹${(captured.amount / 100).toLocaleString("en-IN")}). Donation marked completed and DCC/WhatsApp pipeline triggered.`,
        razorpayPaymentId: captured.id,
        donation: completed,
      });
    } catch (error) {
      console.error("reconcile error", error && error.stack ? error.stack : error);
      res.status(500).json({ message: error.message || "Reconcile failed" });
    }
  },

  checkStatus: async (req, res) => {
    try {
      const { orderId } = req.params;
      if (!orderId) return res.status(400).json({ message: "orderId is required" });

      let donation = await donations.findOne(
        { razorpayOrderId: orderId },
        {
          sort: { createdAt: 1, _id: 1 },
          lean: true,
          fields: [
            "status",
            "receiptNumber",
            "dccSyncStatus",
            "whatsappReceiptSentAt",
            "donorName",
            "amount",
            "sevaName",
            "type",
            "createdAt",
            "razorpayOrderId",
            "paymentAccount",
          ],
        }
      );

      if (!donation) return res.status(404).json({ found: false });

      let inProgress = false;
      if (req.query.live === "1" && donation.status !== "completed") {
        try {
          const live = await liveCheckDonationOrder(donation);
          inProgress = live.inProgress;
          if (live.completed) donation = { ...donation, status: "completed" };
        } catch (e) {
          console.warn("checkStatus live check failed:", e && e.message ? e.message : e);
        }
      }

      res.status(200).json({
        found: true,
        status: donation.status,
        completed: donation.status === "completed",
        inProgress,
        receiptReady: !!donation.receiptNumber,
        whatsappSent: !!donation.whatsappReceiptSentAt,
        donorName: donation.donorName,
        amount: donation.amount,
        sevaName: donation.sevaName || donation.type,
        createdAt: donation.createdAt,
      });
    } catch (error) {
      console.error("checkStatus error", error && error.message ? error.message : error);
      res.status(500).json({ message: "Status check failed" });
    }
  },

  auditSubscriptions: async (req, res) => {
    try {
      const accountName = req.query.account || "default";
      const deep = req.query.deep === "true";
      const created = createRazorpayInstance(accountName);
      if (!created) {
        return res.status(500).json({ message: `Razorpay not configured for account "${accountName}"` });
      }

      const razorpaySubscriptions = await created.instance.subscriptions.all({ count: 100 });
      const results = [];

      for (const sub of razorpaySubscriptions.items || []) {
        const ourDonations = await donations.find(
          { subscriptionId: sub.id },
          {
            sort: { createdAt: 1, _id: 1 },
            lean: true,
            fields: ["donorName", "amount", "status", "razorpayPaymentId", "createdAt", "lastPaymentDate"],
          }
        );

        let razorpayPaymentCount = 0;
        try {
          const invoices = await created.instance.subscriptions.fetch(sub.id);
          razorpayPaymentCount = invoices.paid_count || 0;
        } catch {}

        const ourCompletedCount = ourDonations.filter((d) => d.status === "completed").length;
        const gap = razorpayPaymentCount > ourCompletedCount;

        const entry = {
          subscriptionId: sub.id,
          razorpayStatus: sub.status,
          planId: sub.plan_id,
          razorpayPaidCount: razorpayPaymentCount,
          totalCount: sub.total_count,
          createdAt: sub.created_at ? new Date(sub.created_at * 1000) : null,
          currentEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
          notes: sub.notes || {},
          ourDonationRecords: ourDonations.length,
          ourRecords: ourDonations,
          gap,
        };

        if (deep && gap) {
          try {
            const payments = await created.instance.invoices.all({ subscription_id: sub.id, count: 20 });
            entry.razorpayPayments = (payments.items || []).map((inv) => ({
              invoiceId: inv.id,
              paymentId: inv.payment_id,
              status: inv.status,
              amount: inv.amount ? inv.amount / 100 : null,
              date: inv.date ? new Date(inv.date * 1000) : null,
              customerName: inv.customer_details?.name || null,
              customerEmail: inv.customer_details?.email || null,
              customerContact: inv.customer_details?.contact || null,
            }));
          } catch (e) {
            entry.razorpayPaymentsError = e.message || String(e);
          }
        }

        results.push(entry);
      }

      const withGaps = results.filter((r) => r.gap);
      const noRecordAtAll = results.filter((r) => r.ourDonationRecords === 0);

      res.status(200).json({
        success: true,
        totalRazorpaySubscriptions: results.length,
        subscriptionsWithNoDbRecordAtAll: noRecordAtAll.length,
        subscriptionsWithPaymentGaps: withGaps.length,
        results,
      });
    } catch (error) {
      console.error("auditSubscriptions error", error && error.message ? error.message : error);
      res.status(500).json({ message: error.message || "Audit failed" });
    }
  },

  backfillSubscriptionGaps: async (req, res) => {
    try {
      const accountName = req.query.account || "default";
      const execute = req.query.execute === "true";
      const created = createRazorpayInstance(accountName);
      if (!created) {
        return res.status(500).json({ message: `Razorpay not configured for account "${accountName}"` });
      }

      const razorpaySubscriptions = await created.instance.subscriptions.all({ count: 100 });
      const planCache = new Map();
      const preview = [];
      let recordsCreated = 0;

      for (const sub of razorpaySubscriptions.items || []) {
        const ourDonations = await donations.find(
          { subscriptionId: sub.id },
          { fields: ["razorpayPaymentId", "status"], sort: { createdAt: 1, _id: 1 }, lean: true }
        );
        const ourCompletedCount = ourDonations.filter((d) => d.status === "completed").length;

        let paidCount = 0;
        try {
          const subDetail = await created.instance.subscriptions.fetch(sub.id);
          paidCount = subDetail.paid_count || 0;
        } catch {
          continue;
        }

        if (paidCount <= ourCompletedCount) continue; // no gap for this subscription

        // Seva name from the Plan (cached to avoid refetching the same plan repeatedly).
        let sevaName = "Monthly Seva";
        if (!planCache.has(sub.plan_id)) {
          try {
            const plan = await created.instance.plans.fetch(sub.plan_id);
            planCache.set(sub.plan_id, plan.item && plan.item.name ? plan.item.name : "Monthly Seva");
          } catch {
            planCache.set(sub.plan_id, "Monthly Seva");
          }
        }
        sevaName = planCache.get(sub.plan_id);

        let invoices = [];
        try {
          const invoiceRes = await created.instance.invoices.all({ subscription_id: sub.id, count: 20 });
          invoices = (invoiceRes.items || []).filter((inv) => inv.status === "paid");
        } catch (e) {
          preview.push({ subscriptionId: sub.id, error: `Could not fetch invoices: ${e.message || e}` });
          continue;
        }

        for (const inv of invoices) {
          const alreadyRecorded = await donations.findOne({ razorpayPaymentId: inv.payment_id ?? null });
          if (alreadyRecorded) continue; // this specific charge already has a record

          const entry = {
            subscriptionId: sub.id,
            paymentId: inv.payment_id,
            amount: inv.amount ? inv.amount / 100 : null,
            chargeDate: inv.date ? new Date(inv.date * 1000) : null,
            donorEmail: (inv.customer_details && inv.customer_details.email) || null,
            donorMobile: (inv.customer_details && inv.customer_details.contact) || null,
            sevaName,
          };

          if (execute) {
            const newDonation = await donations.insert(
              castPaymentDonation({
                donorName: entry.donorEmail ? entry.donorEmail.split("@")[0] : "Devotee",
                donorEmail: entry.donorEmail || undefined,
                donorMobile: entry.donorMobile ? entry.donorMobile.replace(/^\+91/, "") : undefined,
                amount: entry.amount,
                type: "Monthly Seva",
                sourcePage: "recovered-subscription-backfill",
                sevaName,
                paymentAccount: accountName,
                subscriptionId: sub.id,
                isRecurring: true,
                status: "pending",
                razorpayPaymentId: inv.payment_id,
                createdAt: entry.chargeDate || new Date(),
              })
            );
            await completeDonation({ donationId: newDonation._id, paymentId: inv.payment_id });
            entry.donationId = String(newDonation._id);
            entry.action = "CREATED_AND_COMPLETED";
            recordsCreated++;
          } else {
            entry.action = "WOULD_CREATE";
          }

          preview.push(entry);
        }
      }

      res.status(200).json({
        success: true,
        mode: execute ? "EXECUTED — records created, DCC+WhatsApp triggered" : "PREVIEW ONLY — nothing created or sent",
        recordsCreated,
        totalGapsFound: preview.length,
        preview,
      });
    } catch (error) {
      console.error("backfillSubscriptionGaps error", error && error.message ? error.message : error);
      res.status(500).json({ message: error.message || "Backfill failed" });
    }
  },
};

export { paymentController, createRazorpayInstance };
