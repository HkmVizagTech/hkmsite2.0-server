import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { registrations, events } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { registrationSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";
import { compilePcre, regexMatches } from "../domain/pcre.js";

const store = makeStore(registrations, registrationSchema);

async function register(req, res) {
  try {
    const { id: eventId } = req.params;
    const event = await events.findById(castQueryId(eventId, "event"), { fields: ["title"] });
    if (!event) return res.status(404).json({ message: "Event not found" });

    const token = uuidv4();
    const payload = { eventId, token, data: {}, files: [] };
    if (req.body) payload.data = { ...req.body };

    if (req.files && Object.keys(req.files).length) {
      const uploaded = [];
      const fileEntries = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
      for (const f of fileEntries) {
        const uploadedRes = await uploadToR2(f.path, `events/${eventId}/registrations`);
        if (uploadedRes && uploadedRes.secure_url) uploaded.push(uploadedRes.secure_url);
        try {
          fs.unlinkSync(f.path);
        } catch (e) {
          /* temp file already gone */
        }
      }
      payload.files = uploaded;
    }

    const reg = await store.create(payload);
    return res.status(201).json({ message: "Registered", token: reg.token, id: reg._id });
  } catch (err) {
    console.error("registration.register error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

// Mongoose ignored NaN skip/limit; a negative limit behaves like its absolute value.
const asWindow = (skip, limit) => ({
  skip: Number.isFinite(skip) && skip > 0 ? skip : 0,
  limit: Number.isFinite(limit) && limit !== 0 ? Math.abs(Math.trunc(limit)) : null,
});

// `{ $regex: q }` with a non-string q: a one-element array / object matched everything, longer arrays errored.
const nameRegex = (q) => {
  if (typeof q === "string") return compilePcre(q);
  if (Array.isArray(q) && q.length > 1) throw new Error("$regex has to be a string");
  return null;
};

async function listRegistrations(req, res) {
  try {
    const { id: eventId } = req.params;
    const { page = 1, limit = 20, q, attended, paid } = req.query;

    const filter = { eventId: castQueryId(eventId, "registration", "eventId") };
    if (typeof attended !== "undefined") filter["attendance.present"] = attended === "true";
    if (typeof paid !== "undefined") filter.paid = paid === "true";
    const re = q ? nameRegex(q) : null;

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const lim = parseInt(limit, 10);
    const win = asWindow(skip, lim);
    const sort = { createdAt: -1, _id: -1 };

    let total;
    let items;
    if (re) {
      const all = (await registrations.find(filter, { sort })).filter((r) => regexMatches(r.data?.name, re));
      total = all.length;
      items = store.shapeAll(all.slice(win.skip, win.limit == null ? undefined : win.skip + win.limit));
    } else {
      total = await registrations.count(filter);
      items = await store.find(filter, { sort, skip: win.skip || undefined, limit: win.limit ?? undefined });
    }

    return res.json({ total, page: parseInt(page, 10), limit: lim, items });
  } catch (err) {
    console.error("registration.listRegistrations error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function markAttendance(req, res) {
  try {
    const { id: eventId, token } = req.params;
    const reg = await registrations.findOne({ eventId: castQueryId(eventId, "registration", "eventId"), token });
    if (!reg) return res.status(404).json({ message: "Registration not found" });

    const attendance = { present: true, at: new Date() };
    if (req.user && req.user._id) attendance.scannedBy = req.user._id;
    await store.saveChanges(reg._id, { attendance });

    return res.json({ message: "Attendance marked", token: reg.token });
  } catch (err) {
    console.error("registration.markAttendance error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function publicCheckin(req, res) {
  try {
    const { id: eventId, token } = req.params;
    const reg = await registrations.findOne({ eventId: castQueryId(eventId, "registration", "eventId"), token });
    if (!reg) return res.status(404).json({ message: "Registration not found" });

    const registration = await store.saveChanges(reg._id, { attendance: { present: true, at: new Date() } });
    return res.json({ message: "Checked in", token: reg.token, registration });
  } catch (err) {
    console.error("registration.publicCheckin error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export { register, listRegistrations, markAttendance, publicCheckin };
