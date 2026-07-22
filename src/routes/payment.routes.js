const express = require('express');
const { paymentController } = require('../controllers/payment.controller');
const { authMiddleware, adminMiddleware } = require('../middlewares/auth.middleware');

const paymentRouter = express.Router();

paymentRouter.post('/order', express.json(), paymentController.createOrder);
paymentRouter.post('/verify', express.json(), paymentController.verifyPayment);

// Three distinct URLs, one per Razorpay account -- each account's own
// dashboard gets its own webhook secret tied unambiguously to its URL.
paymentRouter.post('/webhook', express.raw({ type: '*/*' }), paymentController.webhookFor('default'));
paymentRouter.post('/webhook/donations', express.raw({ type: '*/*' }), paymentController.webhookFor('donations'));
paymentRouter.post('/webhook/touchstone', express.raw({ type: '*/*' }), paymentController.webhookFor('touchstone'));

paymentRouter.post('/reconcile/:donationId', authMiddleware, adminMiddleware, express.json(), paymentController.reconcile);

module.exports = { paymentRouter };
