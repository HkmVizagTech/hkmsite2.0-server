// src/routes/whatsappWebhook.routes.js
//
// Gupshup posts application/json, but its dashboard test-fire and some
// account configurations send application/x-www-form-urlencoded — the global
// express.json() in app.js would leave req.body empty for those, so the
// urlencoded parser is added here at route level.

const express = require("express");
const { whatsappWebhookController } = require("../controllers/whatsappWebhook.controller");

const whatsappWebhookRouter = express.Router();

whatsappWebhookRouter.use(express.urlencoded({ extended: true, limit: "1mb" }));

// The secret is part of the path because Gupshup's self-serve callbacks carry
// no signature and no custom headers. GET is accepted as well so the URL can
// be opened in a browser to confirm it is live before saving it in Gupshup.
whatsappWebhookRouter.post("/gupshup/:secret", whatsappWebhookController.gupshup);
whatsappWebhookRouter.post("/gupshup", whatsappWebhookController.gupshup);
whatsappWebhookRouter.get("/gupshup/:secret", (req, res) =>
  res.status(200).json({ ok: true, endpoint: "gupshup-delivery-callback" })
);

module.exports = { whatsappWebhookRouter };
