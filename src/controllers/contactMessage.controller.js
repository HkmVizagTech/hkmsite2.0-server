import { contactMessages } from "../db/tables.js";

const contactMessageController = {
  create: async (req, res) => {
    try {
      const { name, email, phone, subject, message, authorization } = req.body;
      if (!name || !email || !message) {
        return res.status(400).json({ message: "Name, email, and message are required" });
      }
      const doc = await contactMessages.insert({
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
        phone: phone ? String(phone).trim() : "",
        subject: subject ? String(subject).trim() : "General Enquiry",
        message: String(message).trim(),
        authorization: authorization === true || authorization === "true",
      });
      res.status(201).json({ message: "Message received", id: doc._id });
    } catch (err) {
      console.error("Contact submit error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  list: async (req, res) => {
    try {
      const { status, page = 1, limit = 30 } = req.query;
      const filter = {};
      if (status && status !== "all") filter.status = status;
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
      const [messages, total, newCount] = await Promise.all([
        contactMessages.find(filter, { sort: { createdAt: -1, _id: -1 }, skip: (pageNum - 1) * lim, limit: lim }),
        contactMessages.count(filter),
        contactMessages.count({ status: "new" }),
      ]);
      res.status(200).json({ messages, total, newCount, page: pageNum, totalPages: Math.ceil(total / lim) });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  updateStatus: async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      if (!["new", "read", "responded"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      const doc = await contactMessages.updateById(id, { status });
      if (!doc) return res.status(404).json({ message: "Message not found" });
      res.status(200).json({ message: "Updated", data: doc });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const doc = await contactMessages.deleteById(req.params.id);
      if (!doc) return res.status(404).json({ message: "Message not found" });
      res.status(200).json({ message: "Deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

export { contactMessageController };
