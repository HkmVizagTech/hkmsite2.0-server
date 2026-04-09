const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

if (process.env.DEBUG_ROUTE_DUMP === 'true') {
  const originalAppUse = express.application.use;
  express.application.use = function (...args) {
    if (typeof args[0] === 'string' || args[0] instanceof RegExp) {
      console.log('[DEBUG_ROUTE] app.use route:', args[0]);
    } else if (Array.isArray(args[0])) {
      console.log('[DEBUG_ROUTE] app.use route array:', args[0]);
    }
    return originalAppUse.apply(this, args);
  };

  const originalRouterUse = express.Router.prototype.use;
  express.Router.prototype.use = function (...args) {
    if (typeof args[0] === 'string' || args[0] instanceof RegExp) {
      console.log('[DEBUG_ROUTE] router.use route:', args[0]);
    } else if (Array.isArray(args[0])) {
      console.log('[DEBUG_ROUTE] router.use route array:', args[0]);
    }
    return originalRouterUse.apply(this, args);
  };

  const originalRouterRoute = express.Router.prototype.route;
  express.Router.prototype.route = function (path) {
    console.log('[DEBUG_ROUTE] router.route path:', path);
    return originalRouterRoute.call(this, path);
  };
}


const mongoose = require('mongoose');
const { userRouter } = require("./src/routes/user.routes");
const { eventRouter } = require("./src/routes/event.routes");
const { galleryRouter } = require("./src/routes/gallery.routes");
const { donationRouter } = require("./src/routes/donation.routes");
const { festivalDonationRouter } = require("./src/routes/festivalDonation.routes");
const { paymentRouter } = require("./src/routes/payment.routes");
const { importantDateRouter } = require("./src/routes/importantDate.routes.js");
const app = express();

const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  'https://hkmsite2-0-client-9fyg.vercel.app',
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


app.use(cookieParser());

app.use(express.json());

app.use("/payments", paymentRouter);
app.use("/users", userRouter);
app.use("/events", eventRouter);
app.use("/gallery", galleryRouter);
app.use("/donations", donationRouter);

app.use("/important-dates", importantDateRouter);
app.use("/festival-donations", festivalDonationRouter);


app.get('/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbState = mongoose && mongoose.connection ? mongoose.connection.readyState : 0;
  const ok = dbState === 1;
  res.status(ok ? 200 : 503).json({ server: 'ok', db: { state: states[dbState] || dbState } });
});

module.exports = { app };