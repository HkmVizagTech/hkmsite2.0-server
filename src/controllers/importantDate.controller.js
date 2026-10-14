import { importantDates } from "../db/tables.js";
import { pick } from "../domain/validate.js";
import { pipelineBodyError } from "../domain/odm.js";
import { importantDateSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";

const store = makeStore(importantDates, importantDateSchema);
const EDITABLE = ["title", "date", "description", "type"];

const importantDateController = {
  list: async (req, res) => {
    try {
      const dates = await store.find({}, { sort: { date: 1, _id: 1 } });
      res.status(200).json({ dates });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  get: async (req, res) => {
    try {
      const date = await store.findById(castQueryId(req.params.id, "importantDate"));
      if (!date) return res.status(404).json({ message: "Not found" });
      res.status(200).json({ date });
    } catch (err) {
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  create: async (req, res) => {
    try {
      const { title, date, description, type } = req.body;
      const newDate = await store.create({ title, date, description, type, createdBy: req.user.userId });
      res.status(201).json({ message: "Created", date: newDate });
    } catch (err) {
      res.status(400).json({ message: "Create failed", error: err.message });
    }
  },

  update: async (req, res) => {
    try {
      const id = castQueryId(req.params.id, "importantDate");
      const bad = pipelineBodyError(req.body);
      if (bad) throw bad;
      const updated = await store.updateById(id, pick(req.body || {}, EDITABLE));
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json({ message: "Updated", date: updated });
    } catch (err) {
      res.status(400).json({ message: "Update failed", error: err.message });
    }
  },

  delete: async (req, res) => {
    try {
      const deleted = await importantDates.deleteById(castQueryId(req.params.id, "importantDate"));
      if (!deleted) return res.status(404).json({ message: "Not found" });
      res.json({ message: "Deleted" });
    } catch (err) {
      res.status(500).json({ message: "Delete failed", error: err.message });
    }
  },
};

export { importantDateController };
