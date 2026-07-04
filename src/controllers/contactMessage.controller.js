const { contactMessageModel } = require("../models/contactMessage.model");

const contactMessageController = {
  // PUBLIC - submit the contact form
  create: async (req, res) => {
    try {
      const { name, email, phone, subject, message } = req.body;
      if (!name || !email || !message) {
        return res.status(400).json({ message: "Name, email, and message are required" });
      }
      const doc = await contactMessageModel.create({
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
        phone: phone ? String(phone).trim() : "",
        subject: subject ? String(subject).trim() : "General Enquiry",
        message: String(message).trim(),
      });
      res.status(201).json({ message: "Message received", id: doc._id });
    } catch (err) {
      console.error("Contact submit error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - list, newest first, optional status filter
  list: async (req, res) => {
    try {
      const { status, page = 1, limit = 30 } = req.query;
      const filter = {};
      if (status && status !== "all") filter.status = status;
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
      const [messages, total, newCount] = await Promise.all([
        contactMessageModel
          .find(filter)
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * lim)
          .limit(lim)
          .lean(),
        contactMessageModel.countDocuments(filter),
        contactMessageModel.countDocuments({ status: "new" }),
      ]);
      res.status(200).json({ messages, total, newCount, page: pageNum, totalPages: Math.ceil(total / lim) });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - update status (mark read / responded)
  updateStatus: async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      if (!["new", "read", "responded"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      const doc = await contactMessageModel.findByIdAndUpdate(id, { status }, { new: true });
      if (!doc) return res.status(404).json({ message: "Message not found" });
      res.status(200).json({ message: "Updated", data: doc });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - delete
  delete: async (req, res) => {
    try {
      const doc = await contactMessageModel.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ message: "Message not found" });
      res.status(200).json({ message: "Deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { contactMessageController };
