import { volunteerEvents, volunteerRegistrations } from "../db/tables.js";
import { pick } from "../domain/validate.js";
import { pipelineBodyError } from "../domain/odm.js";
import { volunteerEventSchema, volunteerRegistrationSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";

const events = makeStore(volunteerEvents, volunteerEventSchema);
const registrations = makeStore(volunteerRegistrations, volunteerRegistrationSchema);

const EDITABLE = [
  "title",
  "description",
  "date",
  "endDate",
  "location",
  "image",
  "slots",
  "category",
  "requirements",
  "status",
  "formFields",
];

const volunteerController = {
  listActive: async (req, res) => {
    try {
      const list = await events.find({ status: "active" }, { sort: { date: 1, _id: 1 } });
      res.status(200).json({ events: list });
    } catch (err) {
      console.error("Volunteer listActive error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  listAll: async (req, res) => {
    try {
      const list = await events.find({}, { sort: { createdAt: -1, _id: -1 } });
      res.status(200).json({ events: list });
    } catch (err) {
      console.error("Volunteer listAll error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  get: async (req, res) => {
    try {
      const event = await events.findById(castQueryId(req.params.id, "volunteerEvent"));
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      res.status(200).json({ event });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  create: async (req, res) => {
    try {
      const { title, description, date, endDate, location, image, slots, category, requirements, formFields } =
        req.body;
      if (!title || !description || !date) {
        return res.status(400).json({ message: "Title, description, and date are required" });
      }
      const event = await events.create({
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
      const id = castQueryId(req.params.id, "volunteerEvent");
      const bad = pipelineBodyError(req.body);
      if (bad) throw bad;
      const event = await events.updateById(id, pick(req.body || {}, EDITABLE));
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      res.status(200).json({ message: "Volunteer event updated", event });
    } catch (err) {
      console.error("Volunteer update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const event = await volunteerEvents.deleteById(castQueryId(req.params.id, "volunteerEvent"));
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      await volunteerRegistrations.deleteMany({
        eventId: castQueryId(req.params.id, "volunteerRegistration", "eventId"),
      });
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

      const event = await events.findById(castQueryId(req.params.id, "volunteerEvent"));
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
        const existing = await volunteerRegistrations.findOne({
          eventId: castQueryId(req.params.id, "volunteerRegistration", "eventId"),
          $raw: ["responses->>(?::text) = ?", [emailField.id, email]],
        });
        if (existing) {
          return res.status(400).json({ message: "You have already registered for this event" });
        }
      }

      const registration = await registrations.create({ eventId: req.params.id, responses });
      await volunteerEvents.updateById(castQueryId(req.params.id, "volunteerEvent"), { $inc: { filledSlots: 1 } });

      res.status(201).json({ message: "Registration successful", registration });
    } catch (err) {
      console.error("Volunteer register error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  listRegistrations: async (req, res) => {
    try {
      const list = await registrations.find(
        { eventId: castQueryId(req.params.id, "volunteerRegistration", "eventId") },
        { sort: { createdAt: -1, _id: -1 } }
      );
      res.status(200).json({ registrations: list });
    } catch (err) {
      console.error("Volunteer listRegistrations error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  updateRegistration: async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ message: "Status is required" });
      const registration = await registrations.updateById(castQueryId(req.params.id, "volunteerRegistration"), {
        status,
      });
      if (!registration) return res.status(404).json({ message: "Registration not found" });
      res.status(200).json({ message: "Registration updated", registration });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  deleteRegistration: async (req, res) => {
    try {
      const registration = await volunteerRegistrations.deleteById(castQueryId(req.params.id, "volunteerRegistration"));
      if (!registration) return res.status(404).json({ message: "Registration not found" });
      await volunteerEvents.updateById(castQueryId(registration.eventId, "volunteerEvent"), {
        $inc: { filledSlots: -1 },
      });
      res.status(200).json({ message: "Registration deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

export { volunteerController };
