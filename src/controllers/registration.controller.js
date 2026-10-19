const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { registrationModel } = require("../models/registration.model");
const { eventModel } = require("../models/event.model");
const { uploadToR2 } = require("../utils/r2");

const crypto = require("crypto");

// Fee options an admin can set on an event's registration form, by the key
// the form sends as paymentChoice.
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

async function register(req, res) {
  try {
    const { id: eventId } = req.params;
    if (!/^[0-9a-f]{24}$/i.test(String(eventId))) return res.status(404).json({ message: "Event not found" });
    const event = await eventModel.findById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found" });

    // Paid events: the amount always comes from the event, never the browser.
    const fee = resolveFee(event, req.body && req.body.paymentChoice);
    if (fee && fee.error) return res.status(400).json({ message: fee.error });

    // Razorpay must be set up before we save anything for a paid event.
    let razorpay = null;
    if (fee) {
      const { createRazorpayInstance } = require("./payment.controller");
      razorpay = createRazorpayInstance("default");
      if (!razorpay) return res.status(503).json({ message: "Online payment isn't available right now. Please try again later." });
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
        try { fs.unlinkSync(f.path); } catch (e) { 
 }
      }
      payload.files = uploaded;
    }

    const reg = await registrationModel.create(payload);

    if (!fee) {
      return res.status(201).json({ message: "Registered", token: reg.token, id: reg._id });
    }

    // Paid event: a Razorpay order for exactly this registration. The form
    // opens checkout with it and confirms through verifyRegistrationPayment;
    // the payment.captured webhook also marks it paid if the page is closed.
    let order;
    try {
      order = await razorpay.instance.orders.create({
        amount: Math.round(fee.amount * 100),
        currency: "INR",
        receipt: `evt_${reg._id}`.slice(0, 40),
        notes: { type: "event_registration", registrationId: String(reg._id), eventId: String(eventId) },
      });
    } catch (e) {
      await registrationModel.deleteOne({ _id: reg._id }); // nothing to pay against; don't keep a half registration
      console.error("registration.register order error", e && e.message ? e.message : e);
      return res.status(502).json({ message: "Couldn't start the payment. Please try again." });
    }
    await registrationModel.updateOne({ _id: reg._id }, { razorpayOrderId: order.id });

    return res.status(201).json({
      message: "Registered — payment required",
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

async function listRegistrations(req, res) {
  try {
    const { id: eventId } = req.params;
    const { page = 1, limit = 20, q, attended, paid } = req.query;

    const filter = { eventId };
    if (typeof attended !== 'undefined') filter['attendance.present'] = attended === 'true';
    if (typeof paid !== 'undefined') filter.paid = paid === 'true';
    if (q) filter['data.name'] = { $regex: q, $options: 'i' };

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const total = await registrationModel.countDocuments(filter);
    const items = await registrationModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10));

    return res.json({ total, page: parseInt(page, 10), limit: parseInt(limit, 10), items });
  } catch (err) {
    console.error("registration.listRegistrations error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function markAttendance(req, res) {
  try {
    const { id: eventId, token } = req.params;
    const reg = await registrationModel.findOne({ eventId, token });
    if (!reg) return res.status(404).json({ message: "Registration not found" });

    reg.attendance.present = true;
    reg.attendance.at = new Date();
    if (req.user && req.user._id) reg.attendance.scannedBy = req.user._id;

    await reg.save();

    return res.json({ message: "Attendance marked", token: reg.token });
  } catch (err) {
    console.error("registration.markAttendance error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

async function publicCheckin(req, res) {
  try {
    const { id: eventId, token } = req.params;
    const reg = await registrationModel.findOne({ eventId, token });
    if (!reg) return res.status(404).json({ message: "Registration not found" });
    if (reg.paymentStatus === "pending") {
      return res.status(402).json({ message: "Registration fee not paid yet", token: reg.token });
    }

    if (!reg.attendance) reg.attendance = {};
    reg.attendance.present = true;
    reg.attendance.at = new Date();
    await reg.save();

    return res.json({ message: "Checked in", token: reg.token, registration: reg });
  } catch (err) {
    console.error("registration.publicCheckin error", err);
    return res.status(500).json({ message: "Server error" });
  }
}

/** Marks the registration behind a Razorpay order paid (idempotent). */
async function markRegistrationPaidByOrder({ orderId, paymentId }) {
  if (!orderId) return null;
  return registrationModel.findOneAndUpdate(
    { razorpayOrderId: orderId, paymentStatus: { $ne: "paid" } },
    { paid: true, paymentStatus: "paid", razorpayPaymentId: paymentId, paidAt: new Date() },
    { new: true }
  );
}

// POST /events/:id/registrations/:regId/verify-payment — the form calls this
// after Razorpay checkout succeeds. The signature must be for THIS
// registration's own order (same rule as donations' /payments/verify).
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
    const reg = await registrationModel.findOne({ _id: regId, eventId });
    if (!reg) return res.status(404).json({ message: "Registration not found" });
    if (reg.paymentStatus === "paid") return res.json({ message: "Payment confirmed", token: reg.token });
    if (!reg.razorpayOrderId || reg.razorpayOrderId !== orderId) {
      return res.status(400).json({ message: "This payment does not belong to this registration" });
    }

    const { createRazorpayInstance } = require("./payment.controller");
    const razorpay = createRazorpayInstance("default");
    if (!razorpay) return res.status(503).json({ message: "Payment verification isn't available right now" });
    const expected = crypto.createHmac("sha256", razorpay.account.key_secret).update(`${orderId}|${paymentId}`).digest("hex");
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

module.exports = { register, listRegistrations, markAttendance, publicCheckin, verifyRegistrationPayment, markRegistrationPaidByOrder };
