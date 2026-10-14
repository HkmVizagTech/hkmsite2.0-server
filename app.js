// Must stay the first require in this file — see src/config/timezone.js.
// app.js is required by index.js, which already sets the zone, but it is
// also loadable on its own, and the require is idempotent either way.
import "./src/config/timezone.js";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import { secretMatches } from "./src/middlewares/internalAuth.middleware.js";
import { dbState } from "./src/db/pg.js";


import { userRouter } from "./src/routes/user.routes.js";
import { eventRouter } from "./src/routes/event.routes.js";
import { galleryRouter } from "./src/routes/gallery.routes.js";
import { darshanRouter } from "./src/routes/darshan.routes.js";
import { donationRouter } from "./src/routes/donation.routes.js";
import { preacherRouter } from "./src/routes/preacher.routes.js";
import { donorAuthRouter } from "./src/routes/donorAuth.routes.js";
import { donorRouter } from "./src/routes/donor.routes.js";
import { donationPageRouter } from "./src/routes/donationPage.routes.js";
import { donationAdminRouter } from "./src/routes/donationAdmin.routes.js";
import { festivalDonationRouter } from "./src/routes/festivalDonation.routes.js";
import { festivalShowcaseRouter } from "./src/routes/festivalShowcase.routes.js";
import { ekadashiCampaignRouter } from "./src/routes/ekadashiCampaign.routes.js";
import { paymentRouter } from "./src/routes/payment.routes.js";
import { importantDateRouter } from "./src/routes/importantDate.routes.js";
import { blogRouter } from "./src/routes/blog.routes.js";
import { contactMessageRouter } from "./src/routes/contactMessage.routes.js";
import { dashboardRouter } from "./src/routes/dashboard.routes.js";
import { devoteeRouter } from "./src/routes/devotee.routes.js";
import { siteContentRouter } from "./src/routes/siteContent.routes.js";
import { heroBannerRouter } from "./src/routes/heroBanner.routes.js";
import { sevaStatsRouter } from "./src/routes/sevaStats.routes.js";
import { campaignerRouter } from "./src/routes/campaigner.routes.js";
import { mediaRouter } from "./src/routes/media.routes.js";
import { volunteerRouter } from "./src/routes/volunteer.routes.js";
import { whatsappWebhookRouter } from "./src/routes/whatsappWebhook.routes.js";
import { shopRouter } from "./src/routes/shop.routes.js";
import { shopAdminRouter } from "./src/routes/shopAdmin.routes.js";
import { templeDevoteeRouter } from "./src/routes/templeDevotee.routes.js";
import { cacheStatus } from "./src/cache/memoryCache.js";
import { internalRouter } from "./src/routes/internal.routes.js";
import { runPendingReminders } from "./src/services/pendingReminder.service.js";
import { resendRecentFailedReceipts } from "./src/services/paymentCompletion.service.js";
const app = express();
app.set('trust proxy', 1);

const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  'https://hkmsite2-0-client-9fyg.vercel.app',
  'https://harekrishnavizag.org',
  'https://www.harekrishnavizag.org',
  'http://localhost:3000',
  'http://localhost:8080',
].filter(Boolean));

app.use(
  cors({
    origin: (origin, callback) => {

      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);

      try {
        const hostname = new URL(origin).hostname;
        if (hostname.endsWith('.vercel.app')) return callback(null, true);
        if (hostname === 'harekrishnavizag.org' || hostname.endsWith('.harekrishnavizag.org')) return callback(null, true);
      } catch (e) {

      }

      return callback(new Error('CORS policy: Origin not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    exposedHeaders: ['Set-Cookie', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 204,
  })
);


// gzip/brotli-compress responses (blog HTML, donor lists, etc.) — cheap
// bandwidth/latency win, applied before routes so it covers everything.
// Baseline security headers. crossOriginResourcePolicy is relaxed since
// this API serves JSON/images to a different origin (the Vercel frontend) —
// the strict default would block legitimate cross-origin fetches.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());

app.use(cookieParser());

// Razorpay webhooks MUST receive the raw request body so the route-level
// express.raw() can hand the controller an untouched Buffer for HMAC
// signature verification. If the global express.json() below runs first,
// it consumes the stream and sets req.body to a parsed OBJECT — the
// controller then hashes "[object Object]" instead of the real payload and
// EVERY webhook fails signature validation (400 Invalid signature). That is
// exactly what got the live webhook disabled by Razorpay. Skipping these
// paths here lets the per-route express.raw() in payment.routes.js win.
const WEBHOOK_PATHS = new Set([
  "/payments/webhook",
  "/payments/webhook/donations",
  "/payments/webhook/touchstone",
  "/payments/webhook/shop",
]);
const globalJson = express.json({ limit: '10mb' }); // increased for rich CKEditor HTML payloads
app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();
  return globalJson(req, res, next);
});

app.use("/payments", paymentRouter);
app.use("/users", userRouter);
app.use("/events", eventRouter);
app.use("/gallery", galleryRouter);
app.use("/darshan", darshanRouter);
app.use("/donations", donationRouter);
app.use("/preacher", preacherRouter);
app.use("/donor-auth", donorAuthRouter);
app.use("/donor", donorRouter);
// Temple shop: /shop is the public storefront + customer order history,
// /shop-admin is staff-only product, stock and order management.
app.use("/shop", shopRouter);
app.use("/shop-admin", shopAdminRouter);
app.use("/donation-page", donationPageRouter);
app.use("/donations-admin", donationAdminRouter);
app.use("/blogs", blogRouter);
app.use("/contact-messages", contactMessageRouter);
app.use("/dashboard", dashboardRouter);
app.use("/devotees", devoteeRouter);
app.use("/site-content", siteContentRouter);
app.use("/hero-banners", heroBannerRouter);
app.use("/campaigners", campaignerRouter);
app.use("/temple-devotees", templeDevoteeRouter);
app.use("/media", mediaRouter);
app.use("/seva-stats", sevaStatsRouter);

app.use("/important-dates", importantDateRouter);
app.use("/festival-donations", festivalDonationRouter);
app.use("/festival-showcases", festivalShowcaseRouter);
app.use("/ekadashi-campaign", ekadashiCampaignRouter);
app.use("/volunteers", volunteerRouter);

// Gupshup WhatsApp delivery callbacks (receipt sent / delivered / read /
// failed). Unauthenticated by nature — the shared secret is in the path, and
// the handler answers 200 to everything so Gupshup never retries in a loop.
app.use("/webhooks/whatsapp", whatsappWebhookRouter);

// dev routes removed for production safety

// Internal endpoint for pending-transaction WhatsApp reminders — same pattern
// as the Annadana/Subhojanam site. Intended to be hit by an external cron
// (cron-job.org, UptimeRobot, etc.) with the x-internal-secret header; the
// in-process scheduler in index.js also calls the same logic, and the
// whatsappPendingReminderSent flag keeps both safe from double-sending.
app.get("/api/internal/send-pending-reminders", async (req, res) => {
  if (!secretMatches(req.headers["x-internal-secret"], process.env.INTERNAL_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {

    const result = await runPendingReminders();
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("Pending reminders job error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// Internal endpoint to re-send receipts that never went out during a provider
// outage — written for the window in which every Flaxxa send failed on that
// number's spam/quality limit. Sends through whichever provider is configured
// now (RECEIPT_WHATSAPP_PROVIDER, default gupshup).
//
// GET so it can be triggered from a phone browser:
//   /api/internal/resend-receipts?secret=<INTERNAL_SECRET>&hours=9
//     -> DRY RUN: lists exactly which donations would be messaged, sends nothing
//   /api/internal/resend-receipts?secret=<INTERNAL_SECRET>&hours=9&send=true
//     -> actually sends
//
// Dry run is the DEFAULT deliberately: this endpoint messages real donors, and
// a URL in a browser is one accidental refresh away from re-running. Sending
// requires send=true to be typed on purpose.
//
// Re-running it is safe regardless — it only selects donations with no
// recorded receipt send, and the send path keeps its idempotency guard (no
// force), so an already-receipted donor is skipped, never messaged twice.
// If the HTTP request times out mid-run the sends continue server-side; check
// the logs, or just run it again.
const handleResendReceipts = async (req, res) => {
  const supplied = req.headers["x-internal-secret"] || req.query.secret;
  if (!secretMatches(supplied, process.env.INTERNAL_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const hours = Number(req.query.hours || 9);
  const limit = Number(req.query.limit || 100);
  const delayMs = Number(req.query.delayMs || 900);
  const dryRun = String(req.query.send || "") !== "true";

  try {

    const result = await resendRecentFailedReceipts({ hours, limit, dryRun, delayMs });
    return res.json({
      success: true,
      ...result,
      ...(dryRun
        ? { note: "DRY RUN — nothing was sent. Add &send=true to this URL to send these receipts." }
        : {}),
    });
  } catch (err) {
    console.error("Resend receipts job error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
};

app.get("/api/internal/resend-receipts", handleResendReceipts);
app.post("/api/internal/resend-receipts", handleResendReceipts);

// Read-only donor/donation/subscription/prasadam snapshot for the HKM Vizag
// DRM (donor relationship manager) to sync from. Same x-internal-secret
// convention as the two endpoints above, enforced inside internalRouter
// itself rather than here.
// DRM internal service API on its own sub-path. This site's existing
// /api/internal/send-pending-reminders and /api/internal/resend-receipts
// endpoints are declared above, so ordering currently saves us - but the
// router auth-guards everything under its mount point, so anything added
// below this line would be silently rejected. A distinct prefix removes the
// dependency on declaration order entirely.
app.use("/api/internal/drm", internalRouter);

app.get("/health", async (req, res) => {
  const db = await dbState();
  let cache;
  try {
    cache = cacheStatus();
  } catch (err) {
    cache = { error: err.message };
  }
  res.status(db === "connected" ? 200 : 503).json({ server: "ok", db: { state: db }, cache });
});

// 404 fallback — any unmatched route gets a clean JSON response instead of
// falling through to Express's default HTML "Cannot GET /..." page.
app.use((req, res) => {
  res.status(404).json({ message: `Not found: ${req.method} ${req.originalUrl}` });
});

// GLOBAL ERROR HANDLER — must be last, and must have all 4 params for
// Express to recognize it as an error handler. Without this, ANY thrown
// error or next(err) call anywhere in the app (a multer file-type
// rejection, an uncaught exception, a bad JSON body, etc.) falls through
// to Express's built-in default handler, which returns an HTML page —
// causing the client's `res.json()` to throw a confusing
// "Unexpected token '<' ... is not valid JSON" instead of a real error
// message. This guarantees every response from this server is JSON.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);

  // Multer-specific errors get clearer messages.
  if (err && err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Please use an image under 10MB.'
      : `Upload error: ${err.message}`;
    return res.status(400).json({ message });
  }

  // express.json() body-parser errors (malformed/oversized JSON body).
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Malformed request body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body too large.' });
  }

  const status = err && err.status ? err.status : 500;
  res.status(status).json({ message: (err && err.message) || 'Server error' });
});

export { app };