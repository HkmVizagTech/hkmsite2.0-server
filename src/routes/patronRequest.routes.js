const express = require("express");
const rateLimit = require("express-rate-limit");
const { patronRequestController } = require("../controllers/patronRequest.controller");

const patronRequestRouter = express.Router();

// Public and unauthenticated, so it gets its own limiter: a real visitor
// submits once; this only stops one IP from flooding the callers' queue.
const submitLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests — please try again in a few minutes." },
});

patronRequestRouter.post("/", submitLimit, patronRequestController.create);

module.exports = { patronRequestRouter };
