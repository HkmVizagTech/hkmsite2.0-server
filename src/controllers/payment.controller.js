const Razorpay = require('razorpay');
const crypto = require('crypto');
const { donationModel } = require('../models/donation.model');
const { planModel } = require('../models/plan.model');
const { enqueueJob } = require('../redis/redisClient');
const { completeDonation } = require('../services/paymentCompletion.service');

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
  // Subhojanam donations belong to Touchstone Charities, a separate trust
  // from the main HKM Vizag account -- needs its own Razorpay account so
  // funds settle to the correct entity. NOT YET LIVE: waiting on real
  // RAZORPAY_TOUCHSTONE_KEY_ID/KEY_SECRET (and optionally
  // RAZORPAY_TOUCHSTONE_WEBHOOK_SECRET) from Mukunda. Until those are set,
  // createRazorpayInstance('touchstone') returns null and callers should
  // surface a clear "not configured yet" error rather than silently
  // falling back to the default account (which would send Touchstone's
  // donations to the wrong trust).
  touchstone: {
    key_id: () => process.env.RAZORPAY_TOUCHSTONE_KEY_ID,
    key_secret: () => process.env.RAZORPAY_TOUCHSTONE_KEY_SECRET,
    webhook_secret: () => process.env.RAZORPAY_TOUCHSTONE_WEBHOOK_SECRET,
  },
};

const normalizeAccount = (account) => (
  account && RAZORPAY_ACCOUNTS[account] ? account : 'default'
);

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
    console.log('createRazorpayInstance:', account.name, key_id ? `${key_id.slice(0, 6)}...` : 'not-set');
  } catch (e) {}
  return { account, instance: new Razorpay({ key_id, key_secret }) };
};

const verifySignature = ({ orderId, paymentId, signature, keySecret }) => {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
  return expected === signature;
};

// Inline processor for webhook events, used when the Redis queue is
// unavailable (unreachable, timing out, or not provisioned). Identical
// semantics to worker/paymentWorker.js.
async function processWebhookEventInline(event) {
  switch (event.event) {
    case 'payment.captured': {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      if (!payment) break;
      const orderId = payment.order_id;
      const completedDonation = await completeDonation({ orderId, paymentId: payment.id });
      if (completedDonation) {
        console.log('Donation marked completed for order', orderId);
      } else {
        console.warn('Donation not found for order:', orderId);
      }
      break;
    }
    case 'payment.failed': {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      if (!payment) break;
      const orderId = payment.order_id;
      if (!orderId) break;
      // Only mark as failed if there's no captured payment on this order
      // (Razorpay can send payment.failed for one attempt while a retry
      // succeeds — we don't want to overwrite a completed donation).
      const donation = await donationModel.findOne({ razorpayOrderId: orderId });
      if (donation && donation.status === 'pending') {
        try {
          const created = createRazorpayInstance(donation.paymentAccount);
          if (created) {
            const payments = await created.instance.orders.fetchPayments(orderId);
            const captured = (payments.items || []).find((p) => p.status === 'captured');
            if (captured) {
              await completeDonation({ orderId, paymentId: captured.id });
              console.log('payment.failed webhook but found captured payment for order', orderId);
            } else {
              await donationModel.findByIdAndUpdate(donation._id, {
                status: 'failed',
                razorpayPaymentId: payment.id,
              });
              console.log('Donation marked failed for order', orderId);
            }
          }
        } catch (rzpErr) {
          // If Razorpay check fails, still mark as failed based on the webhook event
          await donationModel.findByIdAndUpdate(donation._id, {
            status: 'failed',
            razorpayPaymentId: payment.id,
          });
          console.log('Donation marked failed (Razorpay check failed) for order', orderId);
        }
      }
      break;
    }
    case 'subscription.activated': {
      const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
      if (sub) await donationModel.findOneAndUpdate({ subscriptionId: sub.id }, { status: 'active' });
      break;
    }
    case 'subscription.cancelled': {
      const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
      if (sub) await donationModel.updateMany({ subscriptionId: sub.id, isRecurring: true, status: { $nin: ['completed', 'cancelled'] } }, { status: 'cancelled' });
      break;
    }
    case 'subscription.completed': {
      const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
      if (sub) await donationModel.findOneAndUpdate({ subscriptionId: sub.id, isRecurring: true, status: 'active' }, { status: 'completed' });
      break;
    }
    default:
      console.log('Unhandled event:', event.event);
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

      if (!amount || Number(amount) < 1) {
        return res.status(400).send('Invalid amount');
      }

      const razorpay = createRazorpayInstance(req.body.account);
      if (!razorpay) return res.status(500).json({ message: 'Razorpay keys not configured on server' });
      const { account, instance } = razorpay;

      const options = {
        amount: Math.round(Number(amount) * 100),
        currency: 'INR',
        receipt: `receipt_${Date.now()}`,
        payment_capture: 1,
        notes: {
          sourcePage: sourcePage || '',
          festivalSlug: req.body.festivalSlug || '',
          sevaName: sevaName || '',
          legacySevaId: legacySevaId ? String(legacySevaId) : '',
          campaignerSlug: req.body.campaignerSlug || '',
        },
      };

      const order = await instance.orders.create(options);

      let resolvedFestivalId = req.body.festivalId;
      if (!resolvedFestivalId && req.body.festivalSlug) {
        try {
          const { festivalDonationModel } = require('../models/festivalDonation.model');
          const fest = await festivalDonationModel.findOne({ slug: req.body.festivalSlug }).select('_id');
          if (fest) resolvedFestivalId = fest._id;
        } catch (err) {
          console.warn('Could not resolve festivalSlug to festivalId', req.body.festivalSlug, err);
        }
      }

      const donation = await donationModel.create({
        donorName: name || req.body.donorName || 'Anonymous',
        donorEmail: email || req.body.donorEmail,
        donorMobile: mobile || req.body.donorMobile,
        amount,
        type: req.body.type || (sourcePage === 'donations' ? 'Donation' : undefined),
        sourcePage,
        sevaName,
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
        // Attribute the donation to the campaigner's selected temple devotee
        // for DCC receipt purposes — snapshot the devotee's enrolledBy ID now
        // so later devotee edits don't retroactively change attribution.
        dccEnrolledById: await (async () => {
          if (!req.body.campaignerSlug) return undefined;
          try {
            const { campaignerModel } = require('../models/campaigner.model');
            const camp = await campaignerModel
              .findOne({ slug: String(req.body.campaignerSlug), status: 'active' })
              .populate('referredByDevotee', 'dccEnrolledById')
              .lean();
            const id = camp?.referredByDevotee?.dccEnrolledById;
            return Number.isFinite(Number(id)) && id != null ? Number(id) : undefined;
          } catch (e) {
            console.warn('campaigner devotee lookup failed:', e.message);
            return undefined;
          }
        })(),
        festivalId: resolvedFestivalId,
        razorpayOrderId: order.id,
        status: 'pending',
        utm: req.body.utm && typeof req.body.utm === 'object' ? {
          source: String(req.body.utm.source || '').slice(0, 100),
          medium: String(req.body.utm.medium || '').slice(0, 100),
          campaign: String(req.body.utm.campaign || '').slice(0, 100),
          content: String(req.body.utm.content || '').slice(0, 100),
          term: String(req.body.utm.term || '').slice(0, 100),
        } : undefined,
        // Meta Pixel/CAPI: browser sends a shared event_id (for dedup) plus
        // the _fbp/_fbc cookies. We also capture the real client IP + UA
        // server-side for better CAPI match quality.
        metaEventId: req.body.metaEventId ? String(req.body.metaEventId).slice(0, 100) : undefined,
        metaFbp: req.body.metaFbp ? String(req.body.metaFbp).slice(0, 200) : undefined,
        metaFbc: req.body.metaFbc ? String(req.body.metaFbc).slice(0, 200) : undefined,
        metaClientIp: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || undefined,
        metaUserAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 400) : undefined,
      });

      return res.status(200).json({ orderId: order.id, key: account.key_id, donationId: donation._id });
    } catch (err) {
      try {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        console.error('createOrder error', serialized);
      } catch (e) {
        console.error('createOrder error', err && err.stack ? err.stack : err);
      }
  let errStr = '';
  try { errStr = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch (e) { errStr = String(err); }
  const razorpayStatus = err && err.statusCode ? err.statusCode : undefined;
  const razorpayBody = err && err.error ? err.error : undefined;
  return res.status(500).json({ message: 'Failed to create order', error: err && err.message ? err.message : errStr, razorpayStatus, razorpayBody });
    }
  },

  // POST /payments/subscription — monthly autopay. Creates a Razorpay Plan
  // for the chosen amount, then a Subscription the donor authorises once via
  // checkout. Razorpay then auto-charges every month. The first charge is
  // confirmed through verifyPayment (subscription-aware); subsequent monthly
  // charges arrive as `subscription.charged` webhook events.
  // NOTE: requires the Subscriptions feature to be enabled on the Razorpay
  // account and API keys with subscription access.
  createSubscription: async (req, res) => {
    try {
      const {
        name, email, mobile, amount, certificate, panNumber,
        sourcePage, sevaName, sevaUnitLabel,
      } = req.body;

      if (!amount || Number(amount) < 1) {
        return res.status(400).send('Invalid amount');
      }

      const razorpay = createRazorpayInstance(req.body.account);
      if (!razorpay) return res.status(500).json({ message: 'Razorpay keys not configured on server' });
      const { account, instance } = razorpay;

      const amountPaise = Math.round(Number(amount) * 100);
      // Number of monthly billing cycles. Razorpay requires a finite count;
      // 120 (10 years) is effectively "until the donor cancels". Override via
      // SUBSCRIPTION_TOTAL_COUNT if a different horizon is desired.
      const totalCount = Number(process.env.SUBSCRIPTION_TOTAL_COUNT || 120);

      // 1) Reuse an existing Razorpay Plan for this amount+account, or create
      // one. Creating a plan per subscription would accumulate thousands of
      // duplicate plans on the Razorpay dashboard.
      let planId;
      const existingPlan = await planModel.findOne({ amount: Number(amount), account: account.name });
      if (existingPlan) {
        planId = existingPlan.planId;
      } else {
        const newPlan = await instance.plans.create({
          period: 'monthly',
          interval: 1,
          item: {
            name: String(sevaName || 'Monthly Seva').slice(0, 250),
            amount: amountPaise,
            currency: 'INR',
          },
          notes: { sevaName: sevaName || '', sourcePage: sourcePage || '' },
        });
        planId = newPlan.id;
        await planModel.create({ amount: Number(amount), account: account.name, planId });
      }

      // 2) A subscription on that plan for the donor to authorise.
      // customer_notify: 0 — we send our own WhatsApp receipt; Razorpay
      // emails/SMS would double-notify the donor.
      const subscription = await instance.subscriptions.create({
        plan_id: planId,
        total_count: totalCount,
        quantity: 1,
        customer_notify: 0,
        notes: {
          sourcePage: sourcePage || '',
          sevaName: sevaName || '',
          sevaUnitLabel: sevaUnitLabel || '',
        },
      });

      // 3) A pending donation record for the first charge, flagged recurring.
      const donation = await donationModel.create({
        donorName: name || req.body.donorName || 'Anonymous',
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
        status: 'pending',
        campaignerSlug: req.body.campaignerSlug || undefined,
        utm: req.body.utm && typeof req.body.utm === 'object' ? {
          source: String(req.body.utm.source || '').slice(0, 100),
          medium: String(req.body.utm.medium || '').slice(0, 100),
          campaign: String(req.body.utm.campaign || '').slice(0, 100),
          content: String(req.body.utm.content || '').slice(0, 100),
          term: String(req.body.utm.term || '').slice(0, 100),
        } : undefined,
      });

      return res.status(200).json({
        subscriptionId: subscription.id,
        key: account.key_id,
        donationId: donation._id,
      });
    } catch (err) {
      let errStr = '';
      try { errStr = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch (e) { errStr = String(err); }
      console.error('createSubscription error', errStr);
      const razorpayStatus = err && err.statusCode ? err.statusCode : undefined;
      const razorpayBody = err && err.error ? err.error : undefined;
      return res.status(500).json({ message: 'Failed to create subscription', error: err && err.message ? err.message : errStr, razorpayStatus, razorpayBody });
    }
  },

  verifyPayment: async (req, res) => {
    try {
      const {
        razorpay_order_id, razorpay_payment_id, razorpay_signature,
        razorpay_subscription_id, donationId,
      } = req.body;
      if (!razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ message: 'Payment verification details missing' });
      }
      const isSubscription = !!razorpay_subscription_id;
      if (!isSubscription && !razorpay_order_id) {
        return res.status(400).json({ message: 'Payment verification details missing' });
      }

      const query = donationId
        ? { _id: donationId }
        : isSubscription
          ? { subscriptionId: razorpay_subscription_id }
          : { razorpayOrderId: razorpay_order_id };
      const donation = await donationModel.findOne(query);
      if (!donation) return res.status(404).json({ message: 'Donation not found' });

      const account = resolveAccount(donation.paymentAccount);
      if (!account.key_secret) return res.status(500).json({ message: 'Razorpay keys not configured on server' });

      // Subscriptions sign as payment_id|subscription_id; one-time orders as
      // order_id|payment_id.
      const signedBody = isSubscription
        ? `${razorpay_payment_id}|${razorpay_subscription_id}`
        : `${razorpay_order_id}|${razorpay_payment_id}`;
      const expected = crypto.createHmac('sha256', account.key_secret).update(signedBody).digest('hex');
      if (expected !== razorpay_signature) {
        return res.status(400).json({ message: 'Invalid payment signature' });
      }

      const updated = await completeDonation({
        donationId: donation._id,
        orderId: isSubscription ? undefined : razorpay_order_id,
        paymentId: razorpay_payment_id,
      });

      return res.status(200).json({ message: 'Payment verified', donation: updated });
    } catch (err) {
      console.error('verifyPayment error', err && err.stack ? err.stack : err);
      return res.status(500).json({ message: 'Failed to verify payment' });
    }
  },

  // Separate, explicit webhook per Razorpay account (each account's own
  // dashboard gets its own URL to paste in, tied to exactly one secret --
  // no ambiguity about which secret belongs where, and no looping through
  // every configured account trying to find a signature match).
  webhookFor: (accountName) => async (req, res) => {
    try {
      const signature = req.headers['x-razorpay-signature'];
      if (!signature) return res.status(400).send('Signature missing');

      const account = resolveAccount(accountName);
      if (!account.webhook_secret) {
        console.warn(`Webhook received for "${accountName}" but no webhook secret is configured for it.`);
        return res.status(500).send(`No webhook secret configured for account "${accountName}"`);
      }

      const body = (req.body && req.body.toString) ? req.body.toString() : JSON.stringify(req.body || {});
      const expected = crypto.createHmac('sha256', account.webhook_secret).update(body).digest('hex');
      if (expected !== signature) {
        console.warn(`Invalid webhook signature for account "${accountName}"`);
        return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(body);
      console.log(`Webhook Event [${accountName}]:`, event.event);

      // CRITICAL: respond to Razorpay IMMEDIATELY after signature
      // verification. Razorpay's delivery timeout is short; any slow work
      // here (Redis enqueue to an unreachable server hangs indefinitely
      // with node-redis's default infinite reconnect) reads as delivery
      // failure and gets the webhook auto-disabled after 24h of retries —
      // which has now happened twice. All processing happens after the
      // response; failures there are logged and recoverable via the
      // /donations/audit-pending reconciliation endpoint.
      res.status(200).send('Webhook received');

      setImmediate(async () => {
        try {
          // Bound the enqueue — never trust Redis to fail fast.
          await Promise.race([
            enqueueJob('payments:jobs', { event: event.event, payload: event.payload, receivedAt: Date.now() }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue timeout (2s)')), 2000)),
          ]);
          return; // worker will process it
        } catch (enqueueErr) {
          console.warn('Failed to enqueue webhook job, falling back to inline processing:', enqueueErr && enqueueErr.message ? enqueueErr.message : enqueueErr);
        }
        try {
          await processWebhookEventInline(event);
        } catch (procErr) {
          console.error('Inline webhook processing error:', procErr && procErr.stack ? procErr.stack : procErr);
        }
      });
    } catch (error) {
      console.error('webhook error', error && error.stack ? error.stack : error);
      if (!res.headersSent) return res.status(500).send('Webhook error');
    }
  },
  // POST /payments/reconcile/:donationId — admin-only manual recovery for a
  // donation stuck 'pending' when the payment actually succeeded on
  // Razorpay's side (e.g. the browser closed before /verify ran, and the
  // webhook either wasn't configured yet or also missed it). Queries
  // Razorpay directly for the real payment status rather than guessing,
  // and only marks it complete if Razorpay confirms a captured payment --
  // runs through the exact same completeDonation() pipeline (DCC +
  // WhatsApp) as a normal successful checkout.
  reconcile: async (req, res) => {
    try {
      const donation = await donationModel.findById(req.params.donationId);
      if (!donation) return res.status(404).json({ message: 'Donation not found' });
      if (!donation.razorpayOrderId) {
        return res.status(400).json({ message: 'This donation has no Razorpay order ID to check.' });
      }
      if (donation.status === 'completed') {
        return res.status(200).json({ message: 'Already marked completed.', status: donation.status });
      }

      const created = createRazorpayInstance(donation.paymentAccount);
      if (!created) {
        return res.status(500).json({ message: `Razorpay is not configured for account "${donation.paymentAccount || 'default'}".` });
      }

      const payments = await created.instance.orders.fetchPayments(donation.razorpayOrderId);
      const captured = (payments.items || []).find((p) => p.status === 'captured');

      if (!captured) {
        const statuses = (payments.items || []).map((p) => p.status);
        return res.status(200).json({
          message: statuses.length
            ? `Razorpay shows no captured payment for this order (found: ${statuses.join(', ')}). Leaving as pending.`
            : 'Razorpay has no payment attempts at all for this order — the donor likely never completed checkout. Leaving as pending.',
          razorpayPayments: payments.items,
        });
      }

      const completed = await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
      return res.status(200).json({
        message: `Razorpay confirms this payment was captured (₹${(captured.amount / 100).toLocaleString('en-IN')}). Donation marked completed and DCC/WhatsApp pipeline triggered.`,
        razorpayPaymentId: captured.id,
        donation: completed,
      });
    } catch (error) {
      console.error('reconcile error', error && error.stack ? error.stack : error);
      res.status(500).json({ message: error.message || 'Reconcile failed' });
    }
  },
};

module.exports = { paymentController, createRazorpayInstance };
