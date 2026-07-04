const express = require("express");
const { contactMessageController } = require("../controllers/contactMessage.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const contactMessageRouter = express.Router();

// PUBLIC - anyone can submit the contact form
contactMessageRouter.post("/", contactMessageController.create);

// ADMIN - view and manage submissions
contactMessageRouter.get("/", authMiddleware, adminMiddleware, contactMessageController.list);
contactMessageRouter.put("/:id/status", authMiddleware, adminMiddleware, contactMessageController.updateStatus);
contactMessageRouter.delete("/:id", authMiddleware, adminMiddleware, contactMessageController.delete);

module.exports = { contactMessageRouter };
