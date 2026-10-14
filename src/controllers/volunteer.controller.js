import { volunteerEvents, volunteerRegistrations } from "../db/tables.js";
import { tx } from "../db/pg.js";
import { validateDoc, pick, toDate } from "../domain/validate.js";

const CATEGORIES = ["festival", "weekly", "special", "outreach"];
const EVENT_STATUSES = ["active", "closed", "completed"];
const FIELD_TYPES = ["text", "email", "tel", "number", "textarea", "select", "checkbox", "date"];
const REG_STATUSES = ["pending", "approved", "rejected", "completed"];
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

// Same shape the old sub-document schema stored.
const normalizeFormFields = (fields) => {
  if (!Array.isArray(fields)) return [];
  return fields.map((f) => {
    validateDoc(
      "volunteerEvent",
      { id: f?.id, label: f?.label, type: f?.type },
      { required: ["id", "label"], enums: { type: FIELD_TYPES } }
    );
    return {
      id: String(f.id),
      type: f.type || "text",
      label: String(f.label),
      placeholder: f.placeholder === undefined || f.placeholder === null ? "" : String(f.placeholder),
      required: f.required === true || f.required === "true",
      options: Array.isArray(f.options) ? f.options.map(String) : [],
    };
  });
};

const volunteerController = {
  listActive: async (req, res) => {
    try {
      const events = await volunteerEvents.find({ status: "active" }, { sort: { date: 1, _id: 1 } });
      res.status(200).json({ events });
    } catch (err) {
      console.error("Volunteer listActive error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  listAll: async (req, res) => {
    try {
      const events = await volunteerEvents.find({}, { sort: { createdAt: -1, _id: -1 } });
      res.status(200).json({ events });
    } catch (err) {
      console.error("Volunteer listAll error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  get: async (req, res) => {
    try {
      const event = await volunteerEvents.findById(req.params.id);
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
      validateDoc("volunteerEvent", { category: category || "festival" }, { enums: { category: CATEGORIES } });
      const event = await volunteerEvents.insert({
        title,
        description,
        date: toDate(date),
        endDate: endDate ? toDate(endDate, "endDate") : undefined,
        location: location || "",
        image: image || "",
        slots: Number(slots) || 0,
        category: category || "festival",
        requirements: requirements || "",
        formFields: normalizeFormFields(formFields),
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
      const patch = pick(req.body || {}, EDITABLE);
      validateDoc("volunteerEvent", patch, { enums: { category: CATEGORIES, status: EVENT_STATUSES } });
      if (patch.date !== undefined) patch.date = toDate(patch.date);
      if (patch.endDate !== undefined) patch.endDate = toDate(patch.endDate, "endDate");
      if (patch.slots !== undefined) patch.slots = Number(patch.slots) || 0;
      if (patch.formFields !== undefined) patch.formFields = normalizeFormFields(patch.formFields);
      const event = await volunteerEvents.updateById(req.params.id, patch);
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      res.status(200).json({ message: "Volunteer event updated", event });
    } catch (err) {
      console.error("Volunteer update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const event = await tx(async (client) => {
        await volunteerRegistrations.deleteMany({ eventId: req.params.id }, { client });
        return volunteerEvents.deleteById(req.params.id, { client });
      });
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
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

      const event = await volunteerEvents.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Volunteer event not found" });
      if (event.status !== "active") {
        return res.status(400).json({ message: "This event is no longer accepting volunteers" });
      }
      if (event.slots > 0 && event.filledSlots >= event.slots) {
        return res.status(400).json({ message: "All volunteer slots are filled" });
      }

      const formFields = event.formFields || [];
      const missing = [];
      for (const field of formFields) {
        if (field.required) {
          const val = responses[field.id];
          if (val === undefined || val === null || val === "") missing.push(field.label);
        }
      }
      if (missing.length > 0) {
        return res.status(400).json({ message: `Required fields missing: ${missing.join(", ")}` });
      }

      const emailField = formFields.find((f) => f.type === "email");
      if (emailField && responses[emailField.id]) {
        const email = String(responses[emailField.id]).toLowerCase();
        responses[emailField.id] = email;
        const existing = await volunteerRegistrations.findOne({
          eventId: req.params.id,
          $raw: ["responses->>(?::text) = ?", [emailField.id, email]],
        });
        if (existing) {
          return res.status(400).json({ message: "You have already registered for this event" });
        }
      }

      const registration = await volunteerRegistrations.insert({ eventId: req.params.id, responses });
      await volunteerEvents.updateById(req.params.id, { $inc: { filledSlots: 1 } });

      res.status(201).json({ message: "Registration successful", registration });
    } catch (err) {
      console.error("Volunteer register error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  listRegistrations: async (req, res) => {
    try {
      const registrations = await volunteerRegistrations.find(
        { eventId: req.params.id },
        { sort: { createdAt: -1, _id: -1 } }
      );
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
      validateDoc("volunteerRegistration", { status }, { enums: { status: REG_STATUSES } });
      const registration = await volunteerRegistrations.updateById(req.params.id, { status });
      if (!registration) return res.status(404).json({ message: "Registration not found" });
      res.status(200).json({ message: "Registration updated", registration });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  deleteRegistration: async (req, res) => {
    try {
      const registration = await volunteerRegistrations.deleteById(req.params.id);
      if (!registration) return res.status(404).json({ message: "Registration not found" });
      await volunteerEvents.updateById(registration.eventId, { $inc: { filledSlots: -1 } });
      res.status(200).json({ message: "Registration deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

export { volunteerController };
