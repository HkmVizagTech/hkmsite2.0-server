const { volunteerEventModel, volunteerRegistrationModel } = require("../models/volunteer.model");

const volunteerController = {
  listActive: async (req, res) => {
    try {
      const events = await volunteerEventModel
        .find({ status: "active" })
        .sort({ date: 1 });
      res.status(200).json({ events });
    } catch (err) {
      console.error("Volunteer listActive error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  listAll: async (req, res) => {
    try {
      const events = await volunteerEventModel.find().sort({ createdAt: -1 });
      res.status(200).json({ events });
    } catch (err) {
      console.error("Volunteer listAll error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  get: async (req, res) => {
    try {
      const event = await volunteerEventModel.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      res.status(200).json({ event });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  create: async (req, res) => {
    try {
      const { title, description, date, endDate, location, image, slots, category, requirements } = req.body;
      if (!title || !description || !date) {
        return res.status(400).json({ message: "Title, description, and date are required" });
      }
      const event = await volunteerEventModel.create({
        title,
        description,
        date,
        endDate: endDate || undefined,
        location: location || "",
        image: image || "",
        slots: slots || 0,
        category: category || "festival",
        requirements: requirements || "",
        createdBy: req.user.userId,
      });
      res.status(201).json({ message: "Volunteer event created", event });
    } catch (err) {
      console.error("Volunteer create error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const event = await volunteerEventModel.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true }
      );
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      res.status(200).json({ message: "Volunteer event updated", event });
    } catch (err) {
      console.error("Volunteer update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const event = await volunteerEventModel.findByIdAndDelete(req.params.id);
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      await volunteerRegistrationModel.deleteMany({ eventId: req.params.id });
      res.status(200).json({ message: "Volunteer event deleted" });
    } catch (err) {
      console.error("Volunteer delete error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  register: async (req, res) => {
    try {
      const { name, email, phone, message } = req.body;
      if (!name || !email || !phone) {
        return res.status(400).json({ message: "Name, email, and phone are required" });
      }

      const event = await volunteerEventModel.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      if (event.status !== "active") {
        return res.status(400).json({ message: "This event is no longer accepting volunteers" });
      }
      if (event.slots > 0 && event.filledSlots >= event.slots) {
        return res.status(400).json({ message: "All volunteer slots are filled" });
      }

      const existing = await volunteerRegistrationModel.findOne({
        eventId: req.params.id,
        email: email.toLowerCase(),
      });
      if (existing) {
        return res.status(400).json({ message: "You have already registered for this event" });
      }

      const registration = await volunteerRegistrationModel.create({
        eventId: req.params.id,
        name,
        email: email.toLowerCase(),
        phone,
        message: message || "",
      });

      await volunteerEventModel.findByIdAndUpdate(req.params.id, {
        $inc: { filledSlots: 1 },
      });

      res.status(201).json({ message: "Registration successful", registration });
    } catch (err) {
      console.error("Volunteer register error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  listRegistrations: async (req, res) => {
    try {
      const registrations = await volunteerRegistrationModel
        .find({ eventId: req.params.id })
        .sort({ createdAt: -1 });
      res.status(200).json({ registrations });
    } catch (err) {
      console.error("Volunteer listRegistrations error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  updateRegistration: async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ message: "Status is required" });
      const registration = await volunteerRegistrationModel.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
      );
      if (!registration) return res.status(404).json({ message: "Registration not found" });
      res.status(200).json({ message: "Registration updated", registration });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  deleteRegistration: async (req, res) => {
    try {
      const registration = await volunteerRegistrationModel.findByIdAndDelete(req.params.id);
      if (!registration) return res.status(404).json({ message: "Registration not found" });
      await volunteerEventModel.findByIdAndUpdate(registration.eventId, {
        $inc: { filledSlots: -1 },
      });
      res.status(200).json({ message: "Registration deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { volunteerController };
