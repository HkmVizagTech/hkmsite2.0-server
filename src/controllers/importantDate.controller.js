import { importantDates } from "../db/tables.js";
import { validateDoc, pick, toDate } from "../domain/validate.js";

const TYPES = ["Ekadashi", "Festival", "Other"];
const EDITABLE = ["title", "date", "description", "type"];

const importantDateController = {
  list: async (req, res) => {
    try {
      const dates = await importantDates.find({}, { sort: { date: 1, _id: 1 } });
      res.status(200).json({ dates });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  get: async (req, res) => {
    try {
      const date = await importantDates.findById(req.params.id);
      if (!date) return res.status(404).json({ message: "Not found" });
      res.status(200).json({ date });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  create: async (req, res) => {
    try {
      const { title, date, description, type } = req.body;
      validateDoc("importantDate", { title, date, type }, { required: ["title", "date"], enums: { type: TYPES } });
      const newDate = await importantDates.insert({
        title,
        date: toDate(date),
        description,
        type,
        createdBy: req.user.userId,
      });
      res.status(201).json({ message: "Created", date: newDate });
    } catch (err) {
      res.status(400).json({ message: "Create failed", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const patch = pick(req.body || {}, EDITABLE);
      validateDoc("importantDate", patch, { enums: { type: TYPES } });
      if (patch.date !== undefined) patch.date = toDate(patch.date);
      const updated = await importantDates.updateById(req.params.id, patch);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json({ message: "Updated", date: updated });
    } catch (err) {
      res.status(400).json({ message: "Update failed", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const deleted = await importantDates.deleteById(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Not found" });
      res.json({ message: "Deleted" });
    } catch (err) {
      res.status(500).json({ message: "Delete failed", error: err.message });
    }
  },
};

export { importantDateController };
