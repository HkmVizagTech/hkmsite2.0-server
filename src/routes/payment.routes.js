const express = require('express');
const { paymentController } = require('../controllers/payment.controller');

const paymentRouter = express.Router();

paymentRouter.post('/order', express.json(), paymentController.createOrder);
paymentRouter.post('/verify', express.json(), paymentController.verifyPayment);

paymentRouter.post('/webhook', express.raw({ type: '*/*' }), paymentController.webhook);

module.exports = { paymentRouter };
