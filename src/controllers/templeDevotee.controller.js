import { templeDevotees } from "../db/tables.js";
import { many } from "../db/pg.js";
import { templeDevoteeSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";

const store = makeStore(templeDevotees, templeDevoteeSchema);

// The old schema stored an explicit null here; keep it in responses.
const shape = (d) => (d ? { dccEnrolledById: null, ...d } : d);

const byName = async (where, params = []) =>
  many(`SELECT * FROM temple_devotees ${where} ORDER BY name COLLATE "C", id`, params);

const templeDevoteeController = {
  publicList: async (req, res) => {
    try {
      const rows = await byName("WHERE status = 'active'");
      res.status(200).json({ success: true, devotees: rows.map((r) => ({ _id: r.id, name: r.name })) });
    } catch (err) {
      console.error("templeDevotee.publicList error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  adminList: async (req, res) => {
    try {
      const rows = await byName("");
      res.status(200).json({ success: true, devotees: rows.map((r) => shape(templeDevotees.fromRow(r, { lean: true }))) });
    } catch (err) {
      console.error("templeDevotee.adminList error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  create: async (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      if (name.length < 2)
        return res.status(400).json({ success: false, message: "Please provide the devotee's name." });
      const dccEnrolledById =
        req.body.dccEnrolledById != null && req.body.dccEnrolledById !== "" ? Number(req.body.dccEnrolledById) : null;
      if (dccEnrolledById != null && !Number.isFinite(dccEnrolledById)) {
        return res.status(400).json({ success: false, message: "DCC Enrolled-By ID must be a number." });
      }
      const devotee = await store.create({ name, dccEnrolledById });
      res.status(201).json({ success: true, devotee: shape(devotee) });
    } catch (err) {
      console.error("templeDevotee.create error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const updates = {};
      if (req.body.name != null) {
        const name = String(req.body.name).trim();
        if (name.length < 2) return res.status(400).json({ success: false, message: "Name too short." });
        updates.name = name;
      }
      if (req.body.dccEnrolledById !== undefined) {
        updates.dccEnrolledById =
          req.body.dccEnrolledById === null || req.body.dccEnrolledById === ""
            ? null
            : Number(req.body.dccEnrolledById);
        if (updates.dccEnrolledById != null && !Number.isFinite(updates.dccEnrolledById)) {
          return res.status(400).json({ success: false, message: "DCC Enrolled-By ID must be a number." });
        }
      }
      if (req.body.status != null) {
        updates.status = req.body.status === "hidden" ? "hidden" : "active";
      }
      const devotee = await store.updateById(castQueryId(req.params.id, "templeDevotee"), updates);
      if (!devotee) return res.status(404).json({ success: false, message: "Devotee not found" });
      res.status(200).json({ success: true, devotee: shape(devotee) });
    } catch (err) {
      console.error("templeDevotee.update error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

export { templeDevoteeController };
