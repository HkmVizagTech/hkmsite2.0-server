import express from "express";
import { contactMessageController } from "../controllers/contactMessage.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const contactMessageRouter = express.Router();

// PUBLIC - anyone can submit the contact form
contactMessageRouter.post("/", contactMessageController.create);

// ADMIN - view and manage submissions
contactMessageRouter.get("/", authMiddleware, adminMiddleware, contactMessageController.list);
contactMessageRouter.put("/:id/status", authMiddleware, adminMiddleware, contactMessageController.updateStatus);
contactMessageRouter.delete("/:id", authMiddleware, adminMiddleware, contactMessageController.delete);

export { contactMessageRouter };