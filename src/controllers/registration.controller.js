import fs from "node:fs";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { registrations, events } from "../db/tables.js";
import { uploadToR2 } from "../utils/r2.js";
import { registrationSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";
import { compilePcre, regexMatches } from "../domain/pcre.js";

const store = makeStore(registrations, registrationSchema);

// Fee options an admin can set on an event's registration form, by the key the form sends as paymentChoice.
const FEE_FIELDS = { student: "studentPrice", job: "jobPrice", general: "price" };

/** { choice, amount } for a paid event, null for a free one, or { error }. */
function resolveFee(event, requestedChoice) {
  const pay = event.registrationForm && event.registrationForm.payment;
  if (!pay || !pay.enabled) return null;
  const priced = Object.entries(FEE_FIELDS)
    .map(([choice, field]) => ({ choice, amount: Number(pay[field]) }))
    .filter((o) => o.amount > 0);
  if (!priced.length) return null; // payment switched on but no price set: treat as free
  const choice = String(requestedChoice || "") || (priced.length === 1 ? priced[0].choice : "");
  const option = priced.find((o) => o.choice === choice);
  if (!option) return { error: "Please choose a registration fee option." };
  return option;
}

// payment.controller imports this module (webhook), so it is loaded lazily.
const razorpayFor = async (name) => (await import("./payment.controller.js")).createRazorpayInstance(name);

async function register(req, res) {
  try {
    const { id: eventId } = req.params;
    if (!/^[0-9a-f]{24}$/i.test(String(eventId))) return res.status(404).json({ message: "Event not found" });
    const event = await events.findById(castQueryId(eventId, "event"), { fields: ["title", "registrationForm"] });
    if (!event) return res.status(404).json({ message: "Event not found" });

    // Paid events: the amount always comes from the event, never the browser.
    const fee = resolveFee(event, req.body && req.body.paymentChoice);
    if (fee && fee.error) return res.status(400).json({ message: fee.error });

    // Razorpay must be set up before we save anything for a paid event.
    let razorpay = null;
    if (fee) {
      razorpay = await razorpayFor("default");
      if (!razorpay)
        return res.status(503).json({ message: "Online payment isn't available right now. Please try again later." });
    }

    const token = uuidv4();
    const payload = { eventId, token, data: {}, files: [] };
    if (req.body) {
      const { paymentChoice, ...fields } = req.body;
      payload.data = fields;
    }
    if (fee) {
      payload.paymentChoice = fee.choice;
      payload.amount = fee.amount;
      payload.paymentStatus = "pending";
    }

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

    if (!fee) {
      return res.status(201).json({ message: "Registered", token: reg.token, id: reg._id });
    }

    // Paid event: a Razorpay order for exactly this registration. The form opens checkout with it and confirms
    // through verifyRegistrationPayment; the payment.captured webhook also marks it paid if the page is closed.
    let order;
    try {
      order = await razorpay.instance.orders.create({
        amount: Math.round(fee.amount * 100),
        currency: "INR",
        receipt: `evt_${reg._id}`.slice(0, 40),
        notes: { type: "event_registration", registrationId: String(reg._id), eventId: String(eventId) },
      });
    } catch (e) {
      await registrations.deleteById(reg._id); // nothing to pay against; don't keep a half registration
      console.error("registration.register order error", e && e.message ? e.message : e);
      return res.status(502).json({ message: "Couldn't start the payment. Please try again." });
    }
    await registrations.updateById(reg._id, { razorpayOrderId: order.id });

    return res.status(201).json({
      message: "Registered - payment required",
      token: reg.token,
      id: reg._id,
      payment: {
        orderId: order.id,
        amount: order.amount, // paise
        currency: order.currency,
        key: razorpay.account.key_id,
        choice: fee.choice,
        eventTitle: event.title,
      },
    });
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
      items = await store.decorate(all.slice(win.skip, win.limit == null ? undefined : win.skip + win.limit));
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
    if (reg.paymentStatus === "pending") {
      return res.status(402).json({ message: "Registration fee not paid yet", token: reg.token });
    }

    const registration = await store.saveChanges(reg._id, { attendance: { present: true, at: new Date() } });
    return res.json({ message: "Checked in", token: reg.token, registration });
  } catch (err) {
    console.error("registration.publicCheckin error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

/** Marks the registration behind a Razorpay order paid (idempotent). */
async function markRegistrationPaidByOrder({ orderId, paymentId }) {
  if (!orderId) return null;
  return registrations.updateOne(
    { razorpayOrderId: orderId, paymentStatus: { $ne: "paid" } },
    { paid: true, paymentStatus: "paid", razorpayPaymentId: paymentId, paidAt: new Date() }
  );
}

// POST /events/:id/registrations/:regId/verify-payment - the form calls this after Razorpay checkout succeeds.
// The signature must be for THIS registration's own order (same rule as donations' /payments/verify).
async function verifyRegistrationPayment(req, res) {
  try {
    const { id: eventId, regId } = req.params;
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const orderId = str(req.body && req.body.razorpay_order_id);
    const paymentId = str(req.body && req.body.razorpay_payment_id);
    const signature = str(req.body && req.body.razorpay_signature);
    if (!/^[0-9a-f]{24}$/i.test(String(regId)) || !orderId || !paymentId || !signature) {
      return res.status(400).json({ message: "Payment details missing" });
    }
    const reg = await registrations.findOne({
      _id: castQueryId(regId, "registration"),
      eventId: castQueryId(eventId, "registration", "eventId"),
    });
    if (!reg) return res.status(404).json({ message: "Registration not found" });
    if (reg.paymentStatus === "paid") return res.json({ message: "Payment confirmed", token: reg.token });
    if (!reg.razorpayOrderId || reg.razorpayOrderId !== orderId) {
      return res.status(400).json({ message: "This payment does not belong to this registration" });
    }

    const razorpay = await razorpayFor("default");
    if (!razorpay) return res.status(503).json({ message: "Payment verification isn't available right now" });
    const expected = crypto
      .createHmac("sha256", razorpay.account.key_secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    const updated = await markRegistrationPaidByOrder({ orderId, paymentId });
    return res.json({ message: "Payment confirmed", token: (updated || reg).token });
  } catch (err) {
    console.error("registration.verifyRegistrationPayment error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export { register, listRegistrations, markAttendance, publicCheckin, verifyRegistrationPayment, markRegistrationPaidByOrder };
