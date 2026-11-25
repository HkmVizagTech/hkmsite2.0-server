const { volunteerEventModel, volunteerRegistrationModel, volunteerSignupModel } = require("../models/volunteer.model");

const INTERESTS = [
  "festivals", "prasadam", "subhojanam", "temple-services", "harinaam", "book-distribution", "outreach",
  "medical", "editorial", "photography", "architecture", "design", "drama", "it", "social-media", "other",
];
const AVAILABILITY = ["daily", "weekdays", "weekends", "festival-days", "flexible"];
const pick = (arr, allowed) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x)))].filter((x) => allowed.includes(x));

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
      const { title, description, date, endDate, location, image, slots, category, requirements, formFields } = req.body;
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
        formFields: formFields || [],
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
      const { responses } = req.body;
      if (!responses || typeof responses !== "object") {
        return res.status(400).json({ message: "Responses are required" });
      }

      const event = await volunteerEventModel.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      if (event.status !== "active") {
        return res.status(400).json({ message: "This event is no longer accepting volunteers" });
      }
      if (event.slots > 0 && event.filledSlots >= event.slots) {
        return res.status(400).json({ message: "All volunteer slots are filled" });
      }

      const missing = [];
      for (const field of event.formFields) {
        if (field.required) {
          const val = responses[field.id];
          if (val === undefined || val === null || val === "") {
            missing.push(field.label);
          }
        }
      }
      if (missing.length > 0) {
        return res.status(400).json({ message: `Required fields missing: ${missing.join(", ")}` });
      }

      const emailField = event.formFields.find((f) => f.type === "email");
      if (emailField && responses[emailField.id]) {
        const email = String(responses[emailField.id]).toLowerCase();
        responses[emailField.id] = email;
        const existing = await volunteerRegistrationModel.findOne({
          eventId: req.params.id,
          [`responses.${emailField.id}`]: email,
        });
        if (existing) {
          return res.status(400).json({ message: "You have already registered for this event" });
        }
      }

      const registration = await volunteerRegistrationModel.create({
        eventId: req.params.id,
        responses,
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

  // PUBLIC — POST /volunteers/signup  (the form on the website's /volunteer page)
  // One entry per mobile number: signing up again just refreshes that person's details.
  signup: async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || "").trim().slice(0, 120);
      const phone = String(b.phone || "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
      if (name.length < 2) return res.status(400).json({ message: "Please enter your name." });
      if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ message: "Please enter a valid 10-digit mobile number." });
      const email = String(b.email || "").trim().toLowerCase().slice(0, 160);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address." });
      const interests = pick(b.skill ? [b.skill] : b.interests, INTERESTS);
      if (interests.length === 0) return res.status(400).json({ message: "Please select your skill / seva area." });
      const availability = pick(b.availability, AVAILABILITY);
      if (availability.length === 0) return res.status(400).json({ message: "Please select your availability." });
      const startDate = new Date(b.startDate);
      if (!b.startDate || Number.isNaN(startDate.getTime())) return res.status(400).json({ message: "Please choose your preferred start date." });
      const age = Number(b.age);
      const gender = ["male", "female", "other"].includes(b.gender) ? b.gender : "";

      const data = {
        name,
        email,
        city: String(b.city || "").trim().slice(0, 120),
        gender,
        occupation: String(b.occupation || "").trim().slice(0, 160),
        interests,
        availability,
        startDate,
        message: String(b.message || "").trim().slice(0, 1000),
      };
      if (Number.isFinite(age) && age >= 5 && age <= 100) data.age = Math.round(age);
      if (b.utm && typeof b.utm === "object") {
        const utm = {};
        for (const k of ["utm_source", "utm_medium", "utm_campaign"]) if (b.utm[k]) utm[k] = String(b.utm[k]).slice(0, 100);
        if (Object.keys(utm).length) data.utm = utm;
      }

      const existing = await volunteerSignupModel.findOne({ phone });
      if (existing) {
        Object.assign(existing, data);
        await existing.save();
        return res.status(200).json({ message: "Updated", alreadyRegistered: true });
      }
      await volunteerSignupModel.create({ ...data, phone });
      return res.status(201).json({ message: "Registered" });
    } catch (err) {
      console.error("Volunteer signup error:", err);
      return res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  },

  // ADMIN — GET /volunteers/admin/signups
  listSignups: async (_req, res) => {
    try {
      const signups = await volunteerSignupModel.find().sort({ createdAt: -1 }).limit(2000).lean();
      res.status(200).json({ signups });
    } catch (err) {
      console.error("Volunteer listSignups error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — PUT /volunteers/admin/signups/:id  { status?, notes? }
  updateSignup: async (req, res) => {
    try {
      const b = req.body || {};
      const set = {};
      if (["new", "contacted", "active", "not_reachable"].includes(b.status)) set.status = b.status;
      if (typeof b.notes === "string") set.notes = b.notes.trim().slice(0, 1000);
      const signup = await volunteerSignupModel.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
      if (!signup) return res.status(404).json({ message: "Not found" });
      res.status(200).json({ signup });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — DELETE /volunteers/admin/signups/:id
  deleteSignup: async (req, res) => {
    try {
      await volunteerSignupModel.findByIdAndDelete(req.params.id);
      res.status(200).json({ message: "Deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
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
