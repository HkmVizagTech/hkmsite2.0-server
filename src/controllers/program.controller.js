const crypto = require("crypto");
const mongoose = require("mongoose");
const { programModel } = require("../models/program.model");
const { programRegistrationModel } = require("../models/programRegistration.model");

// Programs (Admin → Programs) and their public registration pages.
//
// Payments: fees go through the "default" Razorpay account, the same one event
// registration fees use. The order carries notes.type = "program_registration";
// payment.controller's webhook marks the registration paid / failed even when
// the visitor closes the page before the browser confirms.
//
// Program fees are NOT donations — nothing here touches DCC or receipts. The
// only message sent is a WhatsApp "thank you for registering".

const RZP_ACCOUNT = "default";
const STATUSES = ["pending", "paid", "failed", "free"];

const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const cleanMobile = (v) => {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
};
const isValidMobile = (m) => /^[6-9]\d{9}$/.test(m);
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const istDate = (d) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(d)) : "");
const istDateTime = (d) =>
  d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "";
const prettyDate = (d) =>
  d ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(d)) : "";
// "2026-12-06" → that day's start (or end) in IST.
const istDayStart = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? new Date(`${ymd}T00:00:00+05:30`) : null);
const istDayEnd = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? new Date(`${ymd}T23:59:59.999+05:30`) : null);

// ---------------------------------------------------------------- program form

function programFromBody(body, { partial }) {
  const b = body || {};
  const out = {};
  const errors = [];
  const has = (k) => b[k] !== undefined;

  if (!partial || has("name")) {
    out.name = str(b.name, 120);
    if (!out.name) errors.push("Program name is required.");
  }
  if (!partial || has("slug")) {
    out.slug = str(b.slug, 80).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.slug)) errors.push("Page link must be lowercase letters, numbers and dashes (e.g. bala-samskriti).");
  }
  if (has("tagline")) out.tagline = str(b.tagline, 200);
  if (!partial || has("fee")) {
    const fee = Number(b.fee);
    if (!Number.isFinite(fee) || fee < 0) errors.push("Fee must be 0 (free) or more.");
    else out.fee = Math.round(fee);
  }
  if (!partial || has("startDate")) {
    out.startDate = istDayStart(str(b.startDate, 10));
    if (!out.startDate) errors.push("Start date is required.");
  }
  if (has("endDate")) out.endDate = istDayStart(str(b.endDate, 10)) || null;
  if (has("schedule")) out.schedule = str(b.schedule, 120);
  if (has("duration")) out.duration = str(b.duration, 80);
  if (has("forKids")) out.forKids = b.forKids === true || b.forKids === "true";
  for (const k of ["ageMin", "ageMax"]) {
    if (has(k)) out[k] = b[k] === "" || b[k] == null ? undefined : Math.max(0, parseInt(b[k], 10) || 0);
  }
  if (has("venues")) {
    const list = Array.isArray(b.venues) ? b.venues : [];
    out.venues = list
      .map((v) => ({ name: str(v && v.name, 80), mapUrl: str(v && v.mapUrl, 500) }))
      .filter((v) => v.name);
    if (out.venues.some((v) => v.mapUrl && !/^https:\/\//i.test(v.mapUrl))) errors.push("Venue map links must start with https://");
  }
  if (has("contactPhones")) {
    const list = Array.isArray(b.contactPhones) ? b.contactPhones : String(b.contactPhones || "").split(/[,/]/);
    out.contactPhones = list.map((p) => cleanMobile(p)).filter(isValidMobile);
  }
  if (has("capacity")) out.capacity = Math.max(0, parseInt(b.capacity, 10) || 0);
  if (has("registrationOpen")) out.registrationOpen = b.registrationOpen === true || b.registrationOpen === "true";
  if (has("whatsappNote")) out.whatsappNote = str(b.whatsappNote, 300);
  return { out, errors };
}

// What the public page needs — never registrant data.
const publicProgram = (p, paidCount) => ({
  _id: p._id,
  name: p.name,
  slug: p.slug,
  tagline: p.tagline,
  fee: p.fee,
  startDate: p.startDate,
  endDate: p.endDate,
  schedule: p.schedule,
  duration: p.duration,
  forKids: p.forKids,
  ageMin: p.ageMin,
  ageMax: p.ageMax,
  venues: p.venues,
  contactPhones: p.contactPhones,
  registrationOpen: p.registrationOpen,
  full: p.capacity > 0 && paidCount >= p.capacity,
});

const countCompleted = (programId) =>
  programRegistrationModel.countDocuments({ programId, paymentStatus: { $in: ["paid", "free"] } });

// ---------------------------------------------------------------- WhatsApp

// One line on purpose: Meta rejects template variables that contain new lines.
function thankYouMessage(reg, program) {
  const who = reg.parentName || reg.name;
  const parts = [
    program.forKids && reg.parentName
      ? `Hare Krishna ${who}! Thank you for registering ${reg.name} for ${program.name}.`
      : `Hare Krishna ${who}! Thank you for registering for ${program.name}.`,
  ];
  if (program.startDate) parts.push(`Starts: ${prettyDate(program.startDate)}.`);
  if (program.schedule) parts.push(`${program.schedule}.`);
  if (reg.venue) parts.push(`Venue: ${reg.venue}.`);
  if (reg.paymentStatus === "paid" && reg.amount) parts.push(`Fee received: Rs. ${Number(reg.amount).toLocaleString("en-IN")}.`);
  if (program.whatsappNote) parts.push(program.whatsappNote);
  if (program.contactPhones && program.contactPhones.length) parts.push(`For any questions call ${program.contactPhones.join(" / ")}.`);
  parts.push("- Hare Krishna Vaikuntham Cultural Centre");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Sends the thank-you at most once (the verify call and the webhook can both
// get here). `force` lets an admin resend after a failure or to a new number.
// Never throws: a messaging failure must not break a successful registration.
async function sendThankYouWhatsApp(regId, { force = false } = {}) {
  const claimFrom = force ? ["not_sent", "failed", "sent", "sending"] : ["not_sent"];
  const reg = await programRegistrationModel.findOneAndUpdate(
    { _id: regId, paymentStatus: { $in: ["paid", "free"] }, "whatsapp.status": { $in: claimFrom } },
    { $set: { "whatsapp.status": "sending" } },
    { new: true }
  );
  if (!reg) return { ok: false, skipped: true };
  try {
    const { isWhatsAppConfigured, sendUtilityMessage } = require("../services/whatsapp.service");
    if (!isWhatsAppConfigured()) throw new Error("WhatsApp is not configured on the server");
    const program = await programModel.findById(reg.programId).lean();
    if (!program) throw new Error("Program not found");
    await sendUtilityMessage(reg.mobile, thankYouMessage(reg, program));
    await programRegistrationModel.updateOne({ _id: reg._id }, { $set: { "whatsapp.status": "sent", "whatsapp.sentAt": new Date(), "whatsapp.error": "" } });
    return { ok: true };
  } catch (err) {
    const message = (err && err.message ? err.message : String(err)).slice(0, 300);
    console.warn("program WhatsApp thank-you failed:", String(reg._id), message);
    await programRegistrationModel.updateOne({ _id: reg._id }, { $set: { "whatsapp.status": "failed", "whatsapp.error": message } }).catch(() => {});
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------- payment state (shared with the webhook)

/** Marks the registration behind a Razorpay order paid (idempotent) and sends the thank-you. */
async function markProgramRegistrationPaidByOrder({ orderId, paymentId }) {
  if (!orderId) return null;
  const reg = await programRegistrationModel.findOneAndUpdate(
    { razorpayOrderId: orderId, paymentStatus: { $in: ["pending", "failed"] } },
    { $set: { paymentStatus: "paid", razorpayPaymentId: paymentId, paidAt: new Date(), failureReason: "" } },
    { new: true }
  );
  if (reg) setImmediate(() => sendThankYouWhatsApp(reg._id));
  return reg || programRegistrationModel.findOne({ razorpayOrderId: orderId });
}

/**
 * Razorpay payment.failed for a program order. Razorpay can report one failed
 * attempt while a retry in the same checkout succeeds, so check the order for
 * a captured payment before calling it failed. Returns null when the order
 * isn't a program registration.
 */
async function markProgramRegistrationFailedByOrder({ orderId, payment }) {
  if (!orderId) return null;
  const reg = await programRegistrationModel.findOne({ razorpayOrderId: orderId });
  if (!reg) return null;
  if (reg.paymentStatus !== "pending") return reg;
  try {
    const { createRazorpayInstance } = require("./payment.controller");
    const created = createRazorpayInstance(RZP_ACCOUNT);
    if (created) {
      const payments = await created.instance.orders.fetchPayments(orderId);
      const captured = (payments.items || []).find((p) => p.status === "captured");
      if (captured) return markProgramRegistrationPaidByOrder({ orderId, paymentId: captured.id });
    }
  } catch (e) {
    console.warn("program payment.failed: Razorpay check failed", orderId, e && e.message ? e.message : e);
  }
  const reason = str((payment && (payment.error_description || payment.error_reason)) || "", 300);
  return programRegistrationModel.findOneAndUpdate(
    { _id: reg._id, paymentStatus: "pending" },
    { $set: { paymentStatus: "failed", razorpayPaymentId: payment && payment.id, failureReason: reason } },
    { new: true }
  );
}

// ---------------------------------------------------------------- filters

function registrationFilter(q) {
  const filter = {};
  if (isId(q.programId)) filter.programId = new mongoose.Types.ObjectId(String(q.programId));
  if (STATUSES.includes(q.status)) filter.paymentStatus = q.status;
  // "completed" = paid + free
  if (q.status === "completed") filter.paymentStatus = { $in: ["paid", "free"] };
  const venue = str(q.venue, 80);
  if (venue) filter.venue = venue;
  if (["sent", "failed", "not_sent"].includes(q.whatsapp)) filter["whatsapp.status"] = q.whatsapp;
  const from = istDayStart(str(q.from, 10));
  const to = istDayEnd(str(q.to, 10));
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const search = str(q.q, 60);
  if (search) {
    const rx = new RegExp(escapeRx(search), "i");
    filter.$or = [{ name: rx }, { parentName: rx }, { mobile: rx }, { email: rx }, { razorpayPaymentId: rx }];
  }
  return filter;
}

// Counts + money for a set of registrations, in one aggregation.
async function summarize(match) {
  const [byStatus, byVenue, byWhatsapp] = await Promise.all([
    programRegistrationModel.aggregate([
      { $match: match },
      { $group: { _id: "$paymentStatus", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    programRegistrationModel.aggregate([
      { $match: { ...match, paymentStatus: { $in: ["paid", "free"] } } },
      { $group: { _id: "$venue", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    programRegistrationModel.aggregate([
      { $match: { ...match, paymentStatus: { $in: ["paid", "free"] } } },
      { $group: { _id: "$whatsapp.status", count: { $sum: 1 } } },
    ]),
  ]);
  const s = { total: 0, paid: 0, pending: 0, failed: 0, free: 0, collected: 0, pendingAmount: 0 };
  for (const row of byStatus) {
    s[row._id] = row.count;
    s.total += row.count;
    if (row._id === "paid") s.collected = row.amount;
    if (row._id === "pending" || row._id === "failed") s.pendingAmount += row.amount;
  }
  s.registered = s.paid + s.free; // completed registrations
  s.venues = byVenue.map((v) => ({ venue: v._id || "Not chosen", count: v.count }));
  s.whatsapp = Object.fromEntries(byWhatsapp.map((w) => [w._id || "not_sent", w.count]));
  return s;
}

// ---------------------------------------------------------------- controller

const programController = {
  // PUBLIC — GET /programs/public/:slug
  getPublic: async (req, res) => {
    try {
      const slug = str(req.params.slug, 80).toLowerCase();
      const program = await programModel.findOne({ slug }).lean();
      if (!program) return res.status(404).json({ message: "Program not found" });
      res.set("Cache-Control", "public, max-age=60");
      return res.json({ program: publicProgram(program, program.capacity ? await countCompleted(program._id) : 0) });
    } catch (err) {
      console.error("program.getPublic error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // PUBLIC — POST /programs/public/:slug/register
  // Free program → registered right away (+ WhatsApp). Paid program → a
  // pending registration and a Razorpay order the page opens checkout with.
  register: async (req, res) => {
    try {
      const slug = str(req.params.slug, 80).toLowerCase();
      const program = await programModel.findOne({ slug });
      if (!program) return res.status(404).json({ message: "Program not found" });
      if (!program.registrationOpen) return res.status(400).json({ message: "Registrations for this program are closed." });
      if (program.capacity > 0 && (await countCompleted(program._id)) >= program.capacity) {
        return res.status(400).json({ message: "Sorry, this program is full." });
      }

      const b = req.body || {};
      const name = str(b.name, 120);
      const parentName = str(b.parentName, 120);
      const mobile = cleanMobile(b.mobile);
      const email = str(b.email, 160).toLowerCase();
      const note = str(b.note, 500);
      const age = b.age === undefined || b.age === "" ? undefined : parseInt(b.age, 10);
      let venue = str(b.venue, 80);

      if (!name) return res.status(400).json({ message: program.forKids ? "Please enter the child's name." : "Please enter your name." });
      if (program.forKids && !parentName) return res.status(400).json({ message: "Please enter the parent's name." });
      if (!isValidMobile(mobile)) return res.status(400).json({ message: "Please enter a valid 10-digit WhatsApp number." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email, or leave it blank." });
      if (program.forKids || age !== undefined) {
        if (!Number.isInteger(age) || age < 1 || age > 120) return res.status(400).json({ message: "Please enter the age." });
        if ((program.ageMin && age < program.ageMin) || (program.ageMax && age > program.ageMax)) {
          return res.status(400).json({ message: `This program is for ages ${program.ageMin || 0} to ${program.ageMax || "any"}.` });
        }
      }
      if (program.venues.length) {
        const match = program.venues.find((v) => v.name.toLowerCase() === venue.toLowerCase());
        if (!match) return res.status(400).json({ message: "Please choose a venue." });
        venue = match.name;
      } else venue = "";

      const utmIn = b.utm && typeof b.utm === "object" ? b.utm : {};
      const utm = {};
      for (const k of ["source", "medium", "campaign", "content", "term"]) {
        const v = str(utmIn[k], 120);
        if (v) utm[k] = v;
      }

      const fields = { name, parentName, mobile, email, note, venue, ...(age !== undefined ? { age } : {}), ...(Object.keys(utm).length ? { utm } : {}) };

      // Same person registering again (refresh, retry after a failed payment):
      // reuse their record instead of counting them twice.
      const existing = await programRegistrationModel
        .findOne({ programId: program._id, mobile, name: new RegExp(`^${escapeRx(name)}$`, "i") })
        .sort({ createdAt: -1 });
      if (existing && ["paid", "free"].includes(existing.paymentStatus)) {
        return res.status(409).json({ message: `${name} is already registered for ${program.name} with this number. 🙏`, alreadyRegistered: true });
      }

      // Free program
      if (!program.fee) {
        const reg = existing
          ? await programRegistrationModel.findByIdAndUpdate(existing._id, { $set: { ...fields, paymentStatus: "free", amount: 0 } }, { new: true })
          : await programRegistrationModel.create({ ...fields, programId: program._id, paymentStatus: "free", amount: 0 });
        setImmediate(() => sendThankYouWhatsApp(reg._id));
        return res.status(201).json({ message: "Registered", id: reg._id, status: "free" });
      }

      // Paid program — fee always from the program, never the browser.
      const { createRazorpayInstance } = require("./payment.controller");
      const razorpay = createRazorpayInstance(RZP_ACCOUNT);
      if (!razorpay) return res.status(503).json({ message: "Online payment isn't available right now. Please try again later." });

      const reg = existing
        ? await programRegistrationModel.findByIdAndUpdate(existing._id, { $set: { ...fields, amount: program.fee, paymentStatus: "pending", failureReason: "" } }, { new: true })
        : await programRegistrationModel.create({ ...fields, programId: program._id, amount: program.fee, paymentStatus: "pending" });

      let order;
      try {
        order = await razorpay.instance.orders.create({
          amount: Math.round(program.fee * 100),
          currency: "INR",
          receipt: `prg_${reg._id}`.slice(0, 40),
          notes: { type: "program_registration", registrationId: String(reg._id), programId: String(program._id), program: program.name.slice(0, 200) },
        });
      } catch (e) {
        if (!existing) await programRegistrationModel.deleteOne({ _id: reg._id });
        console.error("program.register order error", e && e.message ? e.message : e);
        return res.status(502).json({ message: "Couldn't start the payment. Please try again." });
      }
      await programRegistrationModel.updateOne({ _id: reg._id }, { $set: { razorpayOrderId: order.id } });

      return res.status(201).json({
        message: "Registered — payment required",
        id: reg._id,
        status: "pending",
        payment: { orderId: order.id, amount: order.amount, currency: order.currency, key: razorpay.account.key_id, programName: program.name },
      });
    } catch (err) {
      console.error("program.register error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // PUBLIC — POST /programs/public/registrations/:id/verify
  verify: async (req, res) => {
    try {
      const { id } = req.params;
      const orderId = str(req.body && req.body.razorpay_order_id, 80);
      const paymentId = str(req.body && req.body.razorpay_payment_id, 80);
      const signature = str(req.body && req.body.razorpay_signature, 200);
      if (!isId(id) || !orderId || !paymentId || !signature) return res.status(400).json({ message: "Payment details missing" });
      const reg = await programRegistrationModel.findById(id);
      if (!reg) return res.status(404).json({ message: "Registration not found" });
      if (reg.paymentStatus === "paid") return res.json({ message: "Payment confirmed", status: "paid" });
      if (!reg.razorpayOrderId || reg.razorpayOrderId !== orderId) {
        return res.status(400).json({ message: "This payment does not belong to this registration" });
      }
      const { createRazorpayInstance } = require("./payment.controller");
      const razorpay = createRazorpayInstance(RZP_ACCOUNT);
      if (!razorpay) return res.status(503).json({ message: "Payment verification isn't available right now" });
      const expected = crypto.createHmac("sha256", razorpay.account.key_secret).update(`${orderId}|${paymentId}`).digest("hex");
      if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
        return res.status(400).json({ message: "Invalid payment signature" });
      }
      await markProgramRegistrationPaidByOrder({ orderId, paymentId });
      return res.json({ message: "Payment confirmed", status: "paid" });
    } catch (err) {
      console.error("program.verify error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — GET /programs  (every program with its counts)
  listPrograms: async (req, res) => {
    try {
      const programs = await programModel.find().sort({ startDate: -1 }).lean();
      const rows = await programRegistrationModel.aggregate([
        { $group: { _id: { p: "$programId", s: "$paymentStatus" }, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      ]);
      const counts = {};
      for (const r of rows) {
        const k = String(r._id.p);
        counts[k] = counts[k] || { total: 0, paid: 0, pending: 0, failed: 0, free: 0, collected: 0 };
        counts[k][r._id.s] = r.count;
        counts[k].total += r.count;
        if (r._id.s === "paid") counts[k].collected = r.amount;
      }
      return res.json({
        items: programs.map((p) => ({ ...p, counts: counts[String(p._id)] || { total: 0, paid: 0, pending: 0, failed: 0, free: 0, collected: 0 } })),
      });
    } catch (err) {
      console.error("program.listPrograms error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  createProgram: async (req, res) => {
    try {
      const { out, errors } = programFromBody(req.body, { partial: false });
      if (errors.length) return res.status(400).json({ message: errors.join(" ") });
      if (await programModel.exists({ slug: out.slug })) return res.status(409).json({ message: "Another program already uses this page link." });
      const program = await programModel.create({ ...out, createdBy: req.user && req.user._id });
      return res.status(201).json({ program });
    } catch (err) {
      console.error("program.createProgram error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  updateProgram: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ message: "Program not found" });
      const { out, errors } = programFromBody(req.body, { partial: true });
      if (errors.length) return res.status(400).json({ message: errors.join(" ") });
      if (out.slug && (await programModel.exists({ slug: out.slug, _id: { $ne: req.params.id } }))) {
        return res.status(409).json({ message: "Another program already uses this page link." });
      }
      const program = await programModel.findByIdAndUpdate(req.params.id, { $set: out }, { new: true, runValidators: true });
      if (!program) return res.status(404).json({ message: "Program not found" });
      return res.json({ program });
    } catch (err) {
      console.error("program.updateProgram error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // Only a program nobody has registered for can be deleted (keeps payment records intact).
  deleteProgram: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ message: "Program not found" });
      const n = await programRegistrationModel.countDocuments({ programId: req.params.id });
      if (n) return res.status(409).json({ message: `This program has ${n} registration(s), so it can't be deleted. Close registrations instead.` });
      await programModel.deleteOne({ _id: req.params.id });
      return res.json({ message: "Deleted" });
    } catch (err) {
      console.error("program.deleteProgram error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — GET /programs/stats?programId=&from=&to=&venue=
  stats: async (req, res) => {
    try {
      const { status, q, whatsapp, ...rest } = req.query; // stats ignore status/search filters
      return res.json({ stats: await summarize(registrationFilter(rest)) });
    } catch (err) {
      console.error("program.stats error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — GET /programs/registrations?programId=&status=&venue=&whatsapp=&q=&from=&to=&page=&limit=
  listRegistrations: async (req, res) => {
    try {
      const filter = registrationFilter(req.query);
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const [total, items] = await Promise.all([
        programRegistrationModel.countDocuments(filter),
        programRegistrationModel
          .find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate("programId", "name slug")
          .lean(),
      ]);
      return res.json({ total, page, limit, items });
    } catch (err) {
      console.error("program.listRegistrations error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  exportCsv: async (req, res) => {
    try {
      const rows = await programRegistrationModel.find(registrationFilter(req.query)).sort({ createdAt: 1 }).populate("programId", "name").lean();
      const head = ["Registered on", "Program", "Name", "Age", "Parent's name", "WhatsApp number", "Email", "Venue", "Fee", "Payment status", "Paid on", "Razorpay payment ID", "Paid at venue", "Failure reason", "WhatsApp", "UTM source", "UTM campaign", "Note"];
      const lines = [head.join(",")];
      for (const r of rows) {
        lines.push(
          [
            istDateTime(r.createdAt), r.programId && r.programId.name, r.name, r.age, r.parentName, r.mobile, r.email, r.venue, r.amount,
            r.paymentStatus, istDateTime(r.paidAt), r.razorpayPaymentId, r.manualPayment && r.manualPayment.mode ? `${r.manualPayment.mode} ${r.manualPayment.note || ""}`.trim() : "",
            r.failureReason, r.whatsapp && r.whatsapp.status, r.utm && r.utm.source, r.utm && r.utm.campaign, r.note,
          ].map(csvCell).join(",")
        );
      }
      let label = "all-programs";
      if (isId(req.query.programId)) {
        const p = await programModel.findById(req.query.programId, "slug").lean();
        if (p) label = p.slug;
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${label}-registrations-${istDate(new Date())}.csv"`);
      return res.status(200).send("﻿" + lines.join("\r\n") + "\r\n");
    } catch (err) {
      console.error("program.exportCsv error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — POST /programs/registrations/:id/mark-paid  { mode: "Cash" | "UPI" | ..., note }
  // For fees collected at the venue. Sends the thank-you like an online payment.
  markPaid: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ message: "Registration not found" });
      const mode = str(req.body && req.body.mode, 40) || "Cash";
      const note = str(req.body && req.body.note, 200);
      const reg = await programRegistrationModel.findOneAndUpdate(
        { _id: req.params.id, paymentStatus: { $in: ["pending", "failed"] } },
        { $set: { paymentStatus: "paid", paidAt: new Date(), failureReason: "", manualPayment: { mode, note, by: req.user && req.user._id, at: new Date() } } },
        { new: true }
      );
      if (!reg) return res.status(400).json({ message: "Only a pending or failed registration can be marked paid." });
      setImmediate(() => sendThankYouWhatsApp(reg._id));
      return res.json({ registration: reg });
    } catch (err) {
      console.error("program.markPaid error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  // ADMIN — POST /programs/registrations/:id/check-payment
  // Asks Razorpay about a pending / failed registration's order (catches a
  // payment whose webhook never arrived).
  checkPayment: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ message: "Registration not found" });
      const reg = await programRegistrationModel.findById(req.params.id);
      if (!reg) return res.status(404).json({ message: "Registration not found" });
      if (!reg.razorpayOrderId) return res.json({ registration: reg, message: "No online payment was started for this registration." });
      const { createRazorpayInstance } = require("./payment.controller");
      const created = createRazorpayInstance(RZP_ACCOUNT);
      if (!created) return res.status(503).json({ message: "Razorpay isn't configured" });
      const payments = await created.instance.orders.fetchPayments(reg.razorpayOrderId);
      const items = payments.items || [];
      const captured = items.find((p) => p.status === "captured");
      if (captured) {
        const updated = await markProgramRegistrationPaidByOrder({ orderId: reg.razorpayOrderId, paymentId: captured.id });
        return res.json({ registration: updated, message: "Payment found in Razorpay — marked paid." });
      }
      const lastFailed = items.find((p) => p.status === "failed");
      if (lastFailed && reg.paymentStatus === "pending") {
        const updated = await markProgramRegistrationFailedByOrder({ orderId: reg.razorpayOrderId, payment: lastFailed });
        return res.json({ registration: updated, message: "Razorpay shows only failed attempts — marked failed." });
      }
      return res.json({ registration: reg, message: items.length ? "No successful payment yet." : "The payment was never attempted." });
    } catch (err) {
      console.error("program.checkPayment error", err);
      return res.status(500).json({ message: "Couldn't reach Razorpay. Try again." });
    }
  },

  // ADMIN — POST /programs/registrations/:id/whatsapp  (send / resend the thank-you)
  resendWhatsapp: async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ message: "Registration not found" });
      const result = await sendThankYouWhatsApp(req.params.id, { force: true });
      if (result.skipped) return res.status(400).json({ message: "WhatsApp is sent only for paid (or free) registrations." });
      if (!result.ok) return res.status(502).json({ message: `WhatsApp failed: ${result.error}` });
      return res.json({ message: "WhatsApp sent" });
    } catch (err) {
      console.error("program.resendWhatsapp error", err);
      return res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = {
  programController,
  markProgramRegistrationPaidByOrder,
  markProgramRegistrationFailedByOrder,
  thankYouMessage,
};
