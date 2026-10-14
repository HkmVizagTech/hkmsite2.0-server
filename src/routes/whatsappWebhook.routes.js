import express from "express";
import { whatsappWebhookController } from "../controllers/whatsappWebhook.controller.js";

const whatsappWebhookRouter = express.Router();

whatsappWebhookRouter.use(express.urlencoded({ extended: true, limit: "1mb" }));

whatsappWebhookRouter.post("/gupshup/:secret", whatsappWebhookController.gupshup);
whatsappWebhookRouter.post("/gupshup", whatsappWebhookController.gupshup);
whatsappWebhookRouter.get("/gupshup/:secret", (req, res) =>
  res.status(200).json({ ok: true, endpoint: "gupshup-delivery-callback" })
);

export { whatsappWebhookRouter };
