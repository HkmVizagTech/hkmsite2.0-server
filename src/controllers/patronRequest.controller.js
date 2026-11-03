const { patronRequestModel } = require("../models/patronRequest.model");

const normalizeMobile = (m) => String(m || "").replace(/[\s-]+/g, "").replace(/^\+?91/, "");

const patronRequestController = {
  // PUBLIC - "Become a Patron" form on /patron.
  create: async (req, res) => {
    try {
      const { firstName, lastName, email, phone, city, state, message, authorization } = req.body || {};
      const mobile = normalizeMobile(phone);
      if (!String(firstName || "").trim() || !String(email || "").trim() || !/^\d{10}$/.test(mobile)) {
        return res.status(400).json({ message: "First name, email and a valid 10-digit mobile number are required" });
      }
      const first = String(firstName).trim().slice(0, 80);
      const last = String(lastName || "").trim().slice(0, 80);
      const doc = await patronRequestModel.create({
        firstName: first,
        lastName: last,
        name: `${first} ${last}`.trim(),
        email: String(email).trim().toLowerCase().slice(0, 160),
        mobile,
        city: String(city || "").trim().slice(0, 120),
        state: String(state || "").trim().slice(0, 120),
        message: String(message || "").trim().slice(0, 2000),
        authorization: authorization === true || authorization === "true",
      });
      res.status(201).json({ message: "Patron request received", id: doc._id });
    } catch (err) {
      console.error("Patron request submit error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { patronRequestController };
