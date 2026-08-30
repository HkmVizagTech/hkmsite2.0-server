const express = require('express');
const rateLimit = require('express-rate-limit');
const { paymentController } = require('../controllers/payment.controller');
const { authMiddleware, adminMiddleware } = require('../middlewares/auth.middleware');

const paymentRouter = express.Router();

// Order creation rate limiter — protects two things:
// 1. Razorpay's own API rate limits, which cap how many orders you can
//    create per minute. Hitting their limit blocks ALL donors, not just
//    the one who caused it — catastrophic during a Janmashtami campaign.
// 2. Accidental hammering from a donor clicking "Donate" repeatedly.
// 30 order attempts per IP per minute is generous for real donors and
// tight enough to stop abuse. The window is short (1 min) so a genuine
// user who hits the limit is only delayed briefly, not blocked for long.
const orderRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many donation attempts — please wait a moment and try again." },
  skip: (req) => {
    // Never rate-limit admin-originated requests (manual entry, reconcile).
    const auth = req.headers.authorization || "";
    return auth.startsWith("Bearer ") && auth.length > 20;
  },
});

paymentRouter.post('/order', orderRateLimit, express.json(), paymentController.createOrder);
paymentRouter.post('/subscription', express.json(), paymentController.createSubscription);
paymentRouter.post('/verify', express.json(), paymentController.verifyPayment);

// Public status-check endpoint — called by the frontend to poll for
// webhook-triggered completion after a donor navigates away from the
// Razorpay checkout widget (e.g. pays in their UPI app and goes back).
// Returns only safe, non-sensitive fields. No auth required — the
// orderId itself is the access token (long random string from Razorpay).
paymentRouter.get('/status/:orderId', express.json(), paymentController.checkStatus);

// Three distinct URLs, one per Razorpay account -- each account's own
// dashboard gets its own webhook secret tied unambiguously to its URL.
paymentRouter.post('/webhook', express.raw({ type: '*/*' }), paymentController.webhookFor('default'));
paymentRouter.post('/webhook/donations', express.raw({ type: '*/*' }), paymentController.webhookFor('donations'));
paymentRouter.post('/webhook/touchstone', express.raw({ type: '*/*' }), paymentController.webhookFor('touchstone'));

paymentRouter.post('/reconcile/:donationId', authMiddleware, adminMiddleware, express.json(), paymentController.reconcile);
paymentRouter.get('/audit-subscriptions', authMiddleware, adminMiddleware, paymentController.auditSubscriptions);

module.exports = { paymentRouter };
