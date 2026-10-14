import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { registrations, events } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";

async function register(req, res) {
  try {
    const { id: eventId } = req.params;
    const event = await events.findById(eventId, { fields: ["title"] });
    if (!event) return res.status(404).json({ message: "Event not found" });

    const payload = { eventId, token: uuidv4(), data: req.body ? { ...req.body } : {}, files: [] };

    if (req.files && Object.keys(req.files).length) {
      const fileEntries = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
      for (const f of fileEntries) {
        const uploadedRes = await uploadToR2(f.path, `events/${eventId}/registrations`);
        if (uploadedRes && uploadedRes.secure_url) payload.files.push(uploadedRes.secure_url);
        try {
          fs.unlinkSync(f.path);
        } catch (_) {
          /* temp file already gone */
        }
      }
    }

    const reg = await registrations.insert(payload);
    return res.status(201).json({ message: "Registered", token: reg.token, id: reg._id });
  } catch (err) {
    console.error("registration.register error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function listRegistrations(req, res) {
  try {
    const { id: eventId } = req.params;
    const { page = 1, limit = 20, q, attended, paid } = req.query;

    const filter = { eventId };
    if (typeof attended !== "undefined") filter["attendance.present"] = attended === "true";
    if (typeof paid !== "undefined") filter.paid = paid === "true";
    if (q) filter.$raw = ["data->>'name' ~* ?", [String(q)]];

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const lim = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * lim;

    const total = await registrations.count(filter);
    const items = await registrations.find(filter, { sort: { createdAt: -1, _id: -1 }, skip, limit: lim });

    return res.json({ total, page: pageNum, limit: lim, items });
  } catch (err) {
    console.error("registration.listRegistrations error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function markAttendance(req, res) {
  try {
    const { id: eventId, token } = req.params;
    const reg = await registrations.findOne({ eventId, token });
    if (!reg) return res.status(404).json({ message: "Registration not found" });

    const attendance = { present: true, at: new Date() };
    if (req.user && req.user._id) attendance.scannedBy = req.user._id;
    await registrations.updateById(reg._id, { attendance });

    return res.json({ message: "Attendance marked", token: reg.token });
  } catch (err) {
    console.error("registration.markAttendance error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function publicCheckin(req, res) {
  try {
    const { id: eventId, token } = req.params;
    const reg = await registrations.findOne({ eventId, token });
    if (!reg) return res.status(404).json({ message: "Registration not found" });

    const registration = await registrations.updateById(reg._id, { attendance: { present: true, at: new Date() } });
    return res.json({ message: "Checked in", token: reg.token, registration });
  } catch (err) {
    console.error("registration.publicCheckin error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export { register, listRegistrations, markAttendance, publicCheckin };
