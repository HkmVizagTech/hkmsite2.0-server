// "Prefer PhonePe / UPI?" fallback for the website checkout.
//
// When a donor's Razorpay checkout fails (or they close it), the site offers
// to pay the same amount straight to the temple's website UPI QR. The donation
// record already exists at that point (created by POST /payments/order with
// all the donor's details), so the donor only confirms "I've paid" and the
// name shown in their UPI app.
//
// Those UPI payments have no Razorpay order, so nothing links them to the
// donation automatically. The admin side of this file lists the claims and,
// for each one, the order-less UPI payments Razorpay received around that
// time, so an admin can match them with one click. Matching runs the normal
// completion pipeline (receipt, 80G, DCC, WhatsApp) via completeDonation.

const mongoose = require("mongoose");
const { donationModel } = require("../models/donation.model");
const { createRazorpayInstance } = require("./payment.controller");
const { completeDonation } = require("../services/paymentCompletion.service");
const { liveCheckDonationOrder } = require("../services/liveOrderCheck.service");

const ACCOUNTS = ["default", "donations", "touchstone", "shop"];
const BEFORE_OPEN_MS = 15 * 60 * 1000; // payment can't predate the attempt by much
const AFTER_CLAIM_MS = 6 * 60 * 60 * 1000; // donors sometimes tap "I've paid" late

const validId = (id) => typeof id === "string" && mongoose.Types.ObjectId.isValid(id);
const clean = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The donation for a public fallback call. The Razorpay order id from the same
 * checkout acts as proof the caller started this donation, so nobody can mark
 * someone else's donation by guessing ids.
 */
async function findOwnDonation(body) {
  const { donationId, orderId } = body || {};
  if (!validId(donationId) || typeof orderId !== "string" || !orderId) return null;
  return donationModel.findOne({ _id: donationId, razorpayOrderId: orderId });
}

/** One Razorpay client per distinct configured key (accounts may share keys). */
function razorpayClients() {
  const seen = new Set();
  const out = [];
  for (const name of ACCOUNTS) {
    const created = createRazorpayInstance(name);
    if (!created || seen.has(created.account.key_id)) continue;
    seen.add(created.account.key_id);
    out.push({ name: created.account.name, instance: created.instance });
  }
  return out;
}

async function fetchPaymentAnyAccount(paymentId) {
  for (const { name, instance } of razorpayClients()) {
    try {
      const payment = await instance.payments.fetch(paymentId);
      if (payment && payment.id) return { account: name, payment };
    } catch (_) {
      /* not on this account */
    }
  }
  return null;
}

const summarisePayment = (p, account) => ({
  id: p.id,
  account,
  amount: p.amount / 100,
  status: p.status,
  method: p.method,
  vpa: p.vpa || (p.upi && p.upi.vpa) || "",
  email: p.email || "",
  contact: p.contact || "",
  rrn: (p.acquirer_data && (p.acquirer_data.rrn || p.acquirer_data.upi_transaction_id)) || "",
  description: p.description || "",
  notes: p.notes && !Array.isArray(p.notes) ? p.notes : {},
  createdAt: new Date(p.created_at * 1000),
});

const upiFallbackController = {
  // POST /payments/upi-fallback/opened { donationId, orderId, app }
  opened: async (req, res) => {
    try {
      const donation = await findOwnDonation(req.body);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found." });
      if (donation.status === "completed") return res.json({ success: true, alreadyPaid: true });

      const uf = donation.upiFallback || {};
      if (uf.status === "matched") return res.json({ success: true });
      const app = req.body.app === "phonepe" ? "phonepe" : "other";
      await donationModel.updateOne(
        { _id: donation._id },
        {
          $set: {
            "upiFallback.app": app,
            // keep the FIRST time they opened an app; that's the useful one for matching
            ...(uf.openedAt ? {} : { "upiFallback.openedAt": new Date() }),
            ...(uf.status === "claimed" ? {} : { "upiFallback.status": "opened" }),
          },
        }
      );
      res.json({ success: true });
    } catch (err) {
      console.error("upiFallback.opened error:", err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: "Could not save. Please try again." });
    }
  },

  // POST /payments/upi-fallback/claim { donationId, orderId, payerName }
  claim: async (req, res) => {
    try {
      const donation = await findOwnDonation(req.body);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found." });
      if (donation.status === "completed") return res.json({ success: true, alreadyPaid: true });

      // The Razorpay payment may have gone through after all (webhook late):
      // then there's nothing to match — tell the donor it's paid.
      try {
        const live = await liveCheckDonationOrder(donation);
        if (live.completed) return res.json({ success: true, alreadyPaid: true });
      } catch (e) {
        console.warn("upiFallback.claim live check failed:", e && e.message ? e.message : e);
      }

      const payerName = clean(req.body.payerName, 80);
      if (payerName.length < 2) {
        return res.status(400).json({ success: false, message: "Please enter the name shown in your UPI app." });
      }
      const uf = donation.upiFallback || {};
      if (uf.status === "matched") return res.json({ success: true });
      await donationModel.updateOne(
        { _id: donation._id },
        {
          $set: {
            "upiFallback.status": "claimed",
            "upiFallback.claimedAt": new Date(),
            "upiFallback.payerName": payerName,
            ...(uf.openedAt ? {} : { "upiFallback.openedAt": new Date() }),
          },
        }
      );
      res.json({ success: true });
    } catch (err) {
      console.error("upiFallback.claim error:", err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: "Could not save. Please try again." });
    }
  },

  // GET /donations/upi-claims?status=claimed|opened|matched|dismissed|all
  listClaims: async (req, res) => {
    try {
      const allowed = ["claimed", "opened", "matched", "dismissed"];
      const status = String(req.query.status || "claimed");
      const statuses = status === "all" ? allowed : allowed.includes(status) ? [status] : ["claimed"];
      const claims = await donationModel
        .find({ "upiFallback.status": { $in: statuses } })
        .sort({ "upiFallback.claimedAt": -1, "upiFallback.openedAt": -1 })
        .limit(300)
        .select(
          "donorName donorMobile donorEmail amount sevaName type sourcePage status createdAt razorpayOrderId razorpayPaymentId receiptNumber upiFallback"
        )
        .lean();
      const counts = await donationModel.aggregate([
        { $match: { "upiFallback.status": { $in: allowed } } },
        { $group: { _id: "$upiFallback.status", n: { $sum: 1 } } },
      ]);
      res.json({ claims, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
    } catch (err) {
      console.error("upiFallback.listClaims error:", err && err.message ? err.message : err);
      res.status(500).json({ message: "Could not load UPI claims." });
    }
  },

  // GET /donations/upi-claims/:id/candidates
  // Order-less captured payments (i.e. QR / direct UPI) around the claim time,
  // across every configured Razorpay account.
  candidates: async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ message: "Bad id" });
      const donation = await donationModel.findById(req.params.id).lean();
      if (!donation) return res.status(404).json({ message: "Donation not found" });

      const uf = donation.upiFallback || {};
      const start = new Date((uf.openedAt || donation.createdAt).getTime() - BEFORE_OPEN_MS);
      const end = new Date(Math.min(Date.now(), (uf.claimedAt || uf.openedAt || donation.createdAt).getTime() + AFTER_CLAIM_MS));

      const clients = razorpayClients();
      const payments = [];
      const errors = [];
      for (const { name, instance } of clients) {
        try {
          let skip = 0;
          for (let page = 0; page < 5; page++) {
            const res2 = await instance.payments.all({
              from: Math.floor(start.getTime() / 1000),
              to: Math.floor(end.getTime() / 1000),
              count: 100,
              skip,
            });
            const items = (res2 && res2.items) || [];
            for (const p of items) {
              if (p.status === "captured" && !p.order_id) payments.push(summarisePayment(p, name));
            }
            if (items.length < 100) break;
            skip += 100;
          }
        } catch (e) {
          errors.push(`${name}: ${(e && (e.error && e.error.description)) || (e && e.message) || "failed"}`);
        }
      }

      // Hide payments already matched to another donation.
      const used = new Set(
        (
          await donationModel
            .find({ razorpayPaymentId: { $in: payments.map((p) => p.id) } })
            .select("razorpayPaymentId")
            .lean()
        ).map((d) => d.razorpayPaymentId)
      );
      const ref = (uf.claimedAt || uf.openedAt || donation.createdAt).getTime();
      const list = payments
        .map((p) => ({
          ...p,
          used: used.has(p.id),
          amountMatches: Math.round(p.amount * 100) === Math.round(donation.amount * 100),
          minutesFromClaim: Math.round((p.createdAt.getTime() - ref) / 60000),
        }))
        .sort((a, b) => Number(b.amountMatches) - Number(a.amountMatches) || Math.abs(a.minutesFromClaim) - Math.abs(b.minutesFromClaim));

      res.json({ window: { start, end }, payments: list, accountsChecked: clients.map((c) => c.name), errors });
    } catch (err) {
      console.error("upiFallback.candidates error:", err && err.message ? err.message : err);
      res.status(500).json({ message: "Could not fetch payments from Razorpay." });
    }
  },

  // POST /donations/upi-match { donationId, paymentId } or { donationId, reference }
  //   paymentId: a Razorpay pay_… id (verified against Razorpay)
  //   reference: the UPI reference (UTR) when the payment isn't visible through
  //              the API keys we have — recorded like a Manual Entry
  match: async (req, res) => {
    try {
      const { donationId } = req.body || {};
      const paymentId = clean(req.body && req.body.paymentId, 40);
      const reference = clean(req.body && req.body.reference, 40);
      const force = req.body && req.body.force === true;
      if (!validId(donationId) || (!paymentId && !reference)) {
        return res.status(400).json({ message: "donationId and a Razorpay payment ID or UPI reference are required." });
      }
      const donation = await donationModel.findById(donationId);
      if (!donation) return res.status(404).json({ message: "Donation not found" });
      if (donation.status === "completed") {
        return res.status(409).json({ message: "This donation is already completed." });
      }

      let utr = reference;
      if (paymentId) {
        if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) return res.status(400).json({ message: "That doesn't look like a Razorpay payment ID (pay_…)." });
        const taken = await donationModel.findOne({ razorpayPaymentId: paymentId, _id: { $ne: donation._id } }).select("donorName amount").lean();
        if (taken) return res.status(409).json({ message: `This payment is already matched to ${taken.donorName} (₹${taken.amount}).` });

        const found = await fetchPaymentAnyAccount(paymentId);
        if (!found) return res.status(404).json({ message: "Payment not found on any configured Razorpay account." });
        const p = found.payment;
        if (p.status !== "captured") return res.status(400).json({ message: `Payment status is "${p.status}", not captured.` });
        if (p.amount !== Math.round(donation.amount * 100) && !force) {
          return res.status(409).json({
            message: `Amount differs: payment ₹${p.amount / 100}, donation ₹${donation.amount}. Confirm to match anyway.`,
            needsForce: true,
          });
        }
        utr = (p.acquirer_data && p.acquirer_data.rrn) || utr;
      }

      if (utr) {
        const dup = await donationModel.findOne({ utrNumber: utr, _id: { $ne: donation._id } }).select("donorName amount").lean();
        if (dup) return res.status(409).json({ message: `UPI reference ${utr} is already recorded for ${dup.donorName} (₹${dup.amount}).` });
      }

      await donationModel.updateOne(
        { _id: donation._id },
        {
          $set: {
            "upiFallback.status": "matched",
            "upiFallback.matchedAt": new Date(),
            "upiFallback.matchedBy": (req.user && req.user.userId) || undefined,
            "upiFallback.matchedPaymentId": paymentId || undefined,
            manualPaymentMode: "upi",
            ...(utr ? { utrNumber: utr } : {}),
          },
        }
      );
      const completed = await completeDonation({ donationId: donation._id, paymentId: paymentId || undefined });
      res.json({
        message: "Matched. The receipt / 80G / WhatsApp pipeline has been triggered.",
        donation: completed,
      });
    } catch (err) {
      console.error("upiFallback.match error:", err && err.message ? err.message : err);
      res.status(500).json({ message: (err && err.message) || "Match failed" });
    }
  },

  // POST /donations/upi-dismiss { donationId, note }
  dismiss: async (req, res) => {
    try {
      const { donationId } = req.body || {};
      if (!validId(donationId)) return res.status(400).json({ message: "Bad donationId" });
      const r = await donationModel.updateOne(
        { _id: donationId, "upiFallback.status": { $in: ["opened", "claimed"] } },
        { $set: { "upiFallback.status": "dismissed", "upiFallback.note": clean(req.body.note, 300) || undefined } }
      );
      if (!r.matchedCount) return res.status(404).json({ message: "No open UPI claim for this donation." });
      res.json({ message: "Dismissed." });
    } catch (err) {
      console.error("upiFallback.dismiss error:", err && err.message ? err.message : err);
      res.status(500).json({ message: "Dismiss failed" });
    }
  },
};

module.exports = { upiFallbackController };
