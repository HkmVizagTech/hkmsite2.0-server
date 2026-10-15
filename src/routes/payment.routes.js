import express from "express";
import rateLimit from "express-rate-limit";
import { paymentController } from "../controllers/payment.controller.js";
import { upiFallbackController } from "../controllers/upiFallback.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const paymentRouter = express.Router();

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

paymentRouter.post("/order", orderRateLimit, express.json(), paymentController.createOrder);
paymentRouter.post("/subscription", express.json(), paymentController.createSubscription);
paymentRouter.post("/verify", express.json(), paymentController.verifyPayment);

const upiFallbackRateLimit = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
paymentRouter.post("/upi-fallback/opened", upiFallbackRateLimit, express.json(), upiFallbackController.opened);
paymentRouter.post("/upi-fallback/claim", upiFallbackRateLimit, express.json(), upiFallbackController.claim);

const liveStatusRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.query.live !== "1",
});
paymentRouter.get("/status/:orderId", liveStatusRateLimit, express.json(), paymentController.checkStatus);

// Four distinct URLs, one per Razorpay account -- each account's own
// dashboard gets its own webhook secret tied unambiguously to its URL.
paymentRouter.post("/webhook", express.raw({ type: "*/*" }), paymentController.webhookFor("default"));
paymentRouter.post("/webhook/donations", express.raw({ type: "*/*" }), paymentController.webhookFor("donations"));
paymentRouter.post("/webhook/touchstone", express.raw({ type: "*/*" }), paymentController.webhookFor("touchstone"));
paymentRouter.post("/webhook/shop", express.raw({ type: "*/*" }), paymentController.webhookFor("shop"));

paymentRouter.post(
  "/reconcile/:donationId",
  authMiddleware,
  adminMiddleware,
  express.json(),
  paymentController.reconcile
);
paymentRouter.get("/audit-subscriptions", authMiddleware, adminMiddleware, paymentController.auditSubscriptions);
paymentRouter.post(
  "/backfill-subscription-gaps",
  authMiddleware,
  adminMiddleware,
  paymentController.backfillSubscriptionGaps
);

export { paymentRouter };
