import express from "express";
import rateLimit from "express-rate-limit";
import { productController } from "../controllers/product.controller.js";
import { shopOrderController } from "../controllers/shopOrder.controller.js";
import { donorAuthMiddleware } from "../middlewares/auth.middleware.js";

const shopRouter = express.Router();

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

shopRouter.post("/orders/verify", shopOrderController.verifyPayment);

// ---- Order history (customer session) ----
shopRouter.get("/my-orders", donorAuthMiddleware, shopOrderController.myOrders);
shopRouter.get("/my-orders/:orderNumber", donorAuthMiddleware, shopOrderController.getMyOrder);

export { shopRouter };
