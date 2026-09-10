const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const helmet = require("helmet");
const mongoose = require('mongoose');


const { userRouter } = require("./src/routes/user.routes");
const { eventRouter } = require("./src/routes/event.routes");
const { galleryRouter } = require("./src/routes/gallery.routes");
const { donationRouter } = require("./src/routes/donation.routes");
const { donationPageRouter } = require("./src/routes/donationPage.routes");
const { donationAdminRouter } = require("./src/routes/donationAdmin.routes");
const { festivalDonationRouter } = require("./src/routes/festivalDonation.routes");
const { festivalShowcaseRouter } = require("./src/routes/festivalShowcase.routes");
const { ekadashiCampaignRouter } = require("./src/routes/ekadashiCampaign.routes");
const { paymentRouter } = require("./src/routes/payment.routes");
const { importantDateRouter } = require("./src/routes/importantDate.routes.js");
const { blogRouter } = require("./src/routes/blog.routes");
const { contactMessageRouter } = require("./src/routes/contactMessage.routes");
const { dashboardRouter } = require("./src/routes/dashboard.routes");
const { devoteeRouter } = require("./src/routes/devotee.routes");
const { siteContentRouter } = require("./src/routes/siteContent.routes");
const { heroBannerRouter } = require("./src/routes/heroBanner.routes");
const { sevaStatsRouter } = require("./src/routes/sevaStats.routes");
const { campaignerRouter } = require("./src/routes/campaigner.routes");
const { mediaRouter } = require("./src/routes/media.routes");
const { volunteerRouter } = require("./src/routes/volunteer.routes");
const { whatsappWebhookRouter } = require("./src/routes/whatsappWebhook.routes");
const app = express();

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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
app.use("/donations", donationRouter);
app.use("/donation-page", donationPageRouter);
app.use("/donations-admin", donationAdminRouter);
app.use("/blogs", blogRouter);
app.use("/contact-messages", contactMessageRouter);
app.use("/dashboard", dashboardRouter);
app.use("/devotees", devoteeRouter);
app.use("/site-content", siteContentRouter);
app.use("/hero-banners", heroBannerRouter);
app.use("/campaigners", campaignerRouter);
app.use("/temple-devotees", require("./src/routes/templeDevotee.routes").templeDevoteeRouter);
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
  if (req.headers["x-internal-secret"] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { runPendingReminders } = require("./src/services/pendingReminder.service");
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
  if (!process.env.INTERNAL_SECRET || supplied !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const hours = Number(req.query.hours || 9);
  const limit = Number(req.query.limit || 100);
  const delayMs = Number(req.query.delayMs || 900);
  const dryRun = String(req.query.send || "") !== "true";

  try {
    const { resendRecentFailedReceipts } = require("./src/services/paymentCompletion.service");
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

app.get('/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbState = mongoose && mongoose.connection ? mongoose.connection.readyState : 0;
  const ok = dbState === 1;

  // Redis is reported but deliberately does NOT affect the status code. The
  // cache fails open by design, so a Redis outage means "slower", not
  // "unhealthy" — returning 503 here would take a healthy site out of the
  // load balancer over an optimisation.
  //
  // This block exists because the cache is silent when it fails: without it,
  // a wrong REDIS_URL looks exactly like a working cache that happens to be
  // slow. Read `cache.connected` and the hits/misses counters to confirm
  // Redis is genuinely being used.
  let cache;
  try {
    cache = require('./src/redis/redisClient').cacheStatus();
  } catch (err) {
    cache = { error: err && err.message ? err.message : String(err) };
  }

  res.status(ok ? 200 : 503).json({
    server: 'ok',
    db: { state: states[dbState] || dbState },
    cache,
  });
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

module.exports = { app };
