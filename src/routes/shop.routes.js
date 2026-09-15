const express = require("express");
const rateLimit = require("express-rate-limit");
const { productController } = require("../controllers/product.controller");
const { shopOrderController } = require("../controllers/shopOrder.controller");
const { donorAuthMiddleware } = require("../middlewares/auth.middleware");

const shopRouter = express.Router();

// Same reasoning as the donation order limiter: checkout hits Razorpay's
// order API, and one person hammering "Pay" must not burn through the
// account-wide rate limit that every other devotee shares.
const checkoutRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many checkout attempts — please wait a moment and try again." },
});

// ---- Catalog (public) ----
shopRouter.get("/products", productController.listProducts);
shopRouter.get("/categories", productController.listCategories);
shopRouter.get("/settings", productController.getPublicSettings);
// Declared after the two literal paths above so "categories"/"settings" are
// never swallowed by the :slug parameter.
shopRouter.get("/products/:slug", productController.getProduct);

// ---- Cart (public) ----
shopRouter.post("/cart/quote", shopOrderController.quoteCart);

// ---- Checkout (customer session) ----
shopRouter.post("/orders", donorAuthMiddleware, checkoutRateLimit, shopOrderController.createOrder);

// Deliberately NOT behind donorAuthMiddleware. The Razorpay signature is
// itself cryptographic proof that this exact payment succeeded, and a
// session that expires while the devotee is inside the UPI app must not be
// what decides whether their paid order gets confirmed. The controller
// still enforces ownership when a session IS present.
shopRouter.post("/orders/verify", shopOrderController.verifyPayment);

// ---- Order history (customer session) ----
shopRouter.get("/my-orders", donorAuthMiddleware, shopOrderController.myOrders);
shopRouter.get("/my-orders/:orderNumber", donorAuthMiddleware, shopOrderController.getMyOrder);

module.exports = { shopRouter };
