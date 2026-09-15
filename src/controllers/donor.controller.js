const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");
const { userModel } = require("../models/user.model");

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Our own donation records only tell us what's already been CHARGED, not
// whether the subscription is still running — once a subscription's first
// charge succeeds, that donation record (and every later monthly clone —
// see handleSubscriptionCharged in paymentCompletion.service.js) sits at
// status "completed" forever, because each one is a record of a single past
// payment, not a live reflection of the subscription itself. Whether Razorpay
// will actually charge again next month only exists on Razorpay's side, so
// the donor-facing status is always fetched live rather than inferred here.
// Maps Razorpay's subscription.status values (created, authenticated,
// active, pending, halted, cancelled, completed, expired) onto the smaller
// set the dashboard actually displays.
function mapRazorpaySubscriptionStatus(razorpayStatus) {
  switch (razorpayStatus) {
    case "active":
    case "authenticated":
      return "active";
    case "created":
    case "pending":
    case "halted":
      return "pending";
    case "cancelled":
    case "expired":
      return "cancelled";
    case "completed":
      return "completed";
    default:
      return "pending";
  }
}

const donorController = {
  // GET /donor/me — profile: Donor ID, name, mobile, email, PAN, saved
  // address, "donor since" date, and assigned preacher's name if any.
  me: async (req, res) => {
    try {
      const donor = await donorModel.findById(req.donor.donorId).lean();
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

      let preacherName = null;
      if (donor.assignedPreacherId) {
        const preacher = await userModel.findById(donor.assignedPreacherId).select("name").lean();
        preacherName = preacher ? preacher.name : null;
      }

      res.status(200).json({
        success: true,
        donor: {
          donorId: donor.donorId,
          name: donor.name,
          mobile: donor.mobile,
          email: donor.email,
          panNumber: donor.panNumber || null,
          savedAddress: donor.savedAddress || null,
          preacherName,
          donorSince: donor.createdAt,
        },
      });
    } catch (err) {
      console.error("donor.me error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // PATCH /donor/me — self-service profile edit. Every field is optional so
  // the donor can update just their name, or just add a PAN, without
  // resending everything. Only touches the Donor identity record — never
  // rewrites panNumber/prasadamAddress on past donations, which stay exactly
  // as they were submitted at the time of that donation.
  updateProfile: async (req, res) => {
    try {
      const donor = await donorModel.findById(req.donor.donorId);
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

      const updates = {};

      if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ success: false, message: "Name cannot be empty." });
        updates.name = name.slice(0, 120);
      }

      if (req.body.email !== undefined) {
        const email = String(req.body.email).trim();
        if (email && !EMAIL_REGEX.test(email)) {
          return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        updates.email = email || undefined;
      }

      if (req.body.panNumber !== undefined) {
        const pan = String(req.body.panNumber).trim().toUpperCase();
        if (pan && !PAN_REGEX.test(pan)) {
          return res.status(400).json({ success: false, message: "Please enter a valid PAN (e.g. ABCDE1234F)." });
        }
        updates.panNumber = pan || undefined;
      }

      if (req.body.address !== undefined) {
        const a = req.body.address || {};
        const street = String(a.street || "").trim();
        const city = String(a.city || "").trim();
        const state = String(a.state || "").trim();
        const pincode = String(a.pincode || "").trim();
        const country = String(a.country || "India").trim();
        const anyFilled = street || city || state || pincode;
        if (anyFilled) {
          if (!street || !city || !state || !/^\d{6}$/.test(pincode)) {
            return res.status(400).json({
              success: false,
              message: "Please fill in street, city, state, and a valid 6-digit PIN code for the address.",
            });
          }
          updates.savedAddress = { street, city, state, pincode, country };
        } else {
          updates.savedAddress = undefined;
        }
      }

      // $unset any field explicitly cleared (set to undefined above) instead
      // of leaving a stale value, since Mongoose skips `undefined` on $set.
      const unset = {};
      Object.keys(updates).forEach((key) => {
        if (updates[key] === undefined) {
          unset[key] = "";
          delete updates[key];
        }
      });

      const mongoUpdate = {};
      if (Object.keys(updates).length) mongoUpdate.$set = updates;
      if (Object.keys(unset).length) mongoUpdate.$unset = unset;
      if (!Object.keys(mongoUpdate).length) {
        return res.status(400).json({ success: false, message: "Nothing to update." });
      }

      await donorModel.findByIdAndUpdate(donor._id, mongoUpdate);
      res.status(200).json({ success: true, message: "Profile updated." });
    } catch (err) {
      console.error("donor.updateProfile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/my-donations — this donor's full donation history.
  myDonations: async (req, res) => {
    try {
      const donations = await donationModel
        .find({ donorRecordId: req.donor.donorId })
        .sort({ createdAt: -1 })
        .select("amount sevaName type status receiptNumber createdAt isRecurring subscriptionId")
        .lean();
      res.status(200).json({ success: true, donations });
    } catch (err) {
      console.error("donor.myDonations error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/stats — lifetime giving summary for the dashboard hero:
  // total given (completed donations only — pending/failed never counted),
  // how many distinct sevas they've supported, and "donor since" (their
  // Donor record's creation date, which is their very first donation).
  stats: async (req, res) => {
    try {
      const donor = await donorModel.findById(req.donor.donorId).select("createdAt").lean();
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

      const completed = await donationModel
        .find({ donorRecordId: req.donor.donorId, status: "completed" })
        .select("amount sevaName type")
        .lean();

      const lifetimeTotal = completed.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
      const sevaLabels = new Set(completed.map((d) => (d.sevaName || d.type || "General").trim()).filter(Boolean));

      res.status(200).json({
        success: true,
        stats: {
          lifetimeTotal,
          donationCount: completed.length,
          sevaCount: sevaLabels.size,
          donorSince: donor.createdAt,
        },
      });
    } catch (err) {
      console.error("donor.stats error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/subscriptions — recurring donations (monthly autopay),
  // collapsed from the underlying per-charge donation records into one
  // entry per Razorpay subscription so the donor sees "my monthly Seva —
  // active, 4 charges so far" rather than a flat list of individual
  // charges mixed in with one-time donations.
  subscriptions: async (req, res) => {
    try {
      const donations = await donationModel
        .find({ donorRecordId: req.donor.donorId, isRecurring: true, subscriptionId: { $exists: true, $ne: null } })
        .sort({ createdAt: 1 })
        .select("subscriptionId amount sevaName type status createdAt paymentAccount")
        .lean();

      const bySubscription = new Map();
      for (const d of donations) {
        const key = d.subscriptionId;
        if (!bySubscription.has(key)) {
          bySubscription.set(key, {
            subscriptionId: key,
            sevaName: d.sevaName || d.type || "Monthly Seva",
            amount: d.amount,
            paymentAccount: d.paymentAccount,
            status: d.status, // local fallback only — overwritten below with Razorpay's live status when reachable
            startedAt: d.createdAt,
            lastChargedAt: d.status === "completed" ? d.createdAt : null,
            chargeCount: d.status === "completed" ? 1 : 0,
          });
        } else {
          const entry = bySubscription.get(key);
          entry.amount = d.amount; // most recent charge amount
          if (d.status === "completed") {
            entry.chargeCount += 1;
            entry.lastChargedAt = d.createdAt;
          }
        }
      }

      // Fetch the real current state from Razorpay for each subscription —
      // see mapRazorpaySubscriptionStatus above for why the local records
      // alone can't answer "is this still active?". Falls back to the local
      // (potentially stale) status if Razorpay is unreachable, so the page
      // still renders something rather than erroring out.
      const { createRazorpayInstance } = require("./payment.controller");
      await Promise.all(
        Array.from(bySubscription.values()).map(async (entry) => {
          const created = createRazorpayInstance(entry.paymentAccount);
          if (!created) return;
          try {
            const live = await created.instance.subscriptions.fetch(entry.subscriptionId);
            entry.status = mapRazorpaySubscriptionStatus(live.status);
          } catch (e) {
            // Leave the local fallback status.
          }
        })
      );

      const subscriptions = Array.from(bySubscription.values())
        .map(({ paymentAccount, ...rest }) => rest)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

      res.status(200).json({ success: true, subscriptions });
    } catch (err) {
      console.error("donor.subscriptions error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // POST /donor/subscriptions/:subscriptionId/cancel — donor-initiated
  // cancellation of their own recurring donation. Ownership is checked
  // first (a donation with this subscriptionId must belong to this donor)
  // so a donor can never cancel someone else's subscription just by
  // guessing/copying a subscription ID. Cancels on Razorpay's side
  // immediately (no more auto-charges), then updates our own records —
  // the subscription.cancelled webhook will also fire and is idempotent
  // against this, so there's no harm if both run.
  cancelSubscription: async (req, res) => {
    try {
      const { subscriptionId } = req.params;
      // Ownership check only — NOT used to decide cancellability. Any
      // donation record with this subscriptionId proves it belongs to this
      // donor; which one we happen to find doesn't matter here because its
      // `status` reflects one past charge, not the subscription's current
      // state (see mapRazorpaySubscriptionStatus above). Using that status
      // to gate cancellation would incorrectly block cancelling a perfectly
      // active subscription right after a successful monthly charge, since
      // that record would legitimately read "completed".
      const owned = await donationModel
        .findOne({ subscriptionId, donorRecordId: req.donor.donorId })
        .select("subscriptionId paymentAccount")
        .lean();

      if (!owned) {
        return res.status(404).json({ success: false, message: "Subscription not found." });
      }

      const { createRazorpayInstance } = require("./payment.controller");
      const created = createRazorpayInstance(owned.paymentAccount);
      if (!created) {
        return res.status(500).json({ success: false, message: "Payment provider not configured. Please contact us to cancel." });
      }

      // Check Razorpay's real current status first so we can give an
      // accurate message instead of calling cancel on an already-ended plan.
      try {
        const live = await created.instance.subscriptions.fetch(subscriptionId);
        const liveStatus = mapRazorpaySubscriptionStatus(live.status);
        if (liveStatus === "cancelled") {
          return res.status(200).json({ success: true, message: "This subscription is already cancelled." });
        }
        if (liveStatus === "completed") {
          return res.status(400).json({ success: false, message: "This subscription has already run its full course." });
        }
      } catch (fetchErr) {
        console.error("cancelSubscription fetch error:", fetchErr && fetchErr.message ? fetchErr.message : fetchErr);
        return res.status(502).json({ success: false, message: "Could not reach the payment provider. Please try again shortly." });
      }

      try {
        // Second arg is cancelAtCycleEnd (boolean) per the Razorpay SDK —
        // false means cancel immediately rather than letting the current
        // billing cycle finish out first.
        await created.instance.subscriptions.cancel(subscriptionId, false);
      } catch (rzpErr) {
        // Razorpay returns 400 if the subscription is already cancelled/
        // completed/expired on their side — treat that as success rather
        // than surfacing a confusing error for a donor's already-stopped plan.
        const already = rzpErr && rzpErr.error && /already|cancel/i.test(rzpErr.error.description || "");
        if (!already) {
          console.error("cancelSubscription Razorpay error:", rzpErr && rzpErr.message ? rzpErr.message : rzpErr);
          return res.status(502).json({ success: false, message: "Could not reach the payment provider. Please try again shortly." });
        }
      }

      // Best-effort local bookkeeping — flips any record that's still
      // pending/active locally to cancelled. Records already "completed"
      // (past charges) are correctly left untouched; the subscription.
      // cancelled webhook covers the rest and is idempotent against this.
      await donationModel.updateMany(
        { subscriptionId, donorRecordId: req.donor.donorId, status: { $nin: ["completed", "cancelled"] } },
        { status: "cancelled" }
      );

      res.status(200).json({ success: true, message: "Your recurring donation has been cancelled." });
    } catch (err) {
      console.error("donor.cancelSubscription error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/receipt/:donationId — download own receipt PDF. Ownership
  // is checked (donorRecordId must match the logged-in donor) before
  // generating anything, so a donor can never fetch someone else's
  // receipt just by guessing/incrementing an ID.
  downloadReceipt: async (req, res) => {
    try {
      const donation = await donationModel.findOne({ _id: req.params.donationId, donorRecordId: req.donor.donorId });
      if (!donation) return res.status(404).json({ success: false, message: "Receipt not found." });
      if (donation.status !== "completed" || !donation.receiptNumber) {
        return res.status(400).json({ success: false, message: "This donation doesn't have a receipt yet." });
      }

      const { generateReceiptBuffer } = require("../services/receipt.service");
      const pdfBytes = await generateReceiptBuffer(donation._id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="receipt-${donation.receiptNumber.replace(/\|/g, "-")}.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("donor.downloadReceipt error:", err);
      res.status(500).json({ success: false, message: "Could not generate receipt." });
    }
  },
};

module.exports = { donorController };
