const Razorpay = require('razorpay');
const crypto = require('crypto');
const { donationModel } = require('../models/donation.model');
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
        wantPrasadam: mahaprasadam || req.body.wantPrasadam,
        prasadamAddress: prasadamAddress || req.body.prasadamAddress,
        festivalSlug: req.body.festivalSlug || undefined,
        campaignerSlug: req.body.campaignerSlug || undefined,
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

  verifyPayment: async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, donationId } = req.body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ message: 'Payment verification details missing' });
      }

      const query = donationId
        ? { _id: donationId, razorpayOrderId: razorpay_order_id }
        : { razorpayOrderId: razorpay_order_id };
      const donation = await donationModel.findOne(query);
      if (!donation) return res.status(404).json({ message: 'Donation not found' });

      const account = resolveAccount(donation.paymentAccount);
      if (!account.key_secret) return res.status(500).json({ message: 'Razorpay keys not configured on server' });

      const valid = verifySignature({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        keySecret: account.key_secret,
      });

      if (!valid) return res.status(400).json({ message: 'Invalid payment signature' });

      const updated = await completeDonation({
        donationId: donation._id,
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
      });

      return res.status(200).json({ message: 'Payment verified', donation: updated });
    } catch (err) {
      console.error('verifyPayment error', err && err.stack ? err.stack : err);
      return res.status(500).json({ message: 'Failed to verify payment' });
    }
  },

  webhook: async (req, res) => {
    try {
      const signature = req.headers['x-razorpay-signature'];
      if (!signature) return res.status(400).send('Signature missing');

      const body = (req.body && req.body.toString) ? req.body.toString() : JSON.stringify(req.body || {});
      const webhookAccounts = Object.keys(RAZORPAY_ACCOUNTS)
        .map(resolveAccount)
        .filter((account) => account.webhook_secret);
      const matchedAccount = webhookAccounts.find((account) => {
        const expected = crypto.createHmac('sha256', account.webhook_secret).update(body).digest('hex');
        return expected === signature;
      });
      if (!matchedAccount) {
        console.warn('Invalid webhook signature');
        console.log('Received signature:', signature);
        return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(body);
      console.log('Webhook Event:', event.event);

      try {
        await enqueueJob('payments:jobs', { event: event.event, payload: event.payload, receivedAt: Date.now() });
        return res.status(200).send('Webhook enqueued');
      } catch (enqueueErr) {
        console.warn('Failed to enqueue webhook job, falling back to inline processing', enqueueErr && enqueueErr.message ? enqueueErr.message : enqueueErr);
      }

      switch (event.event) {
        case 'payment.captured': {
          const payment = event.payload && event.payload.payment && event.payload.payment.entity;
          if (!payment) break;
          const orderId = payment.order_id;
          const completedDonation = await completeDonation({
            orderId,
            paymentId: payment.id,
          });
          if (completedDonation) {
            console.log('Donation marked completed for order', orderId);
          } else {
            console.warn('Donation not found for order:', orderId);
          }
          break;
        }
        default:
          console.log('Unhandled event:', event.event);
      }

      return res.status(200).send('Webhook processed');
    } catch (error) {
      console.error('webhook error', error && error.stack ? error.stack : error);
      return res.status(500).send('Webhook error');
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

module.exports = { paymentController };
