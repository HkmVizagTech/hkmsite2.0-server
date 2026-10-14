import { donors, donations, users, donorIssues } from "../db/tables.js";
import { aggregate, castId, istMonth } from "../domain/donationQuery.js";
import { createRazorpayInstance } from "./payment.controller.js";
import { generateReceiptBuffer } from "../services/receipt.service.js";

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Our own donation records only tell us what's already been CHARGED, not
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
      const donor = await donors.findById(req.donor.donorId, { lean: true });
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

      let preacherName = null;
      if (donor.assignedPreacherId) {
        const preacher = await users.findById(donor.assignedPreacherId, { fields: ["name"], lean: true });
        preacherName = preacher ? preacher.name : null;
      }

      res.status(200).json({
        success: true,
        donor: {
          // DCC's own DonorNumber (e.g. "D49822") is the real, authoritative
          donorId: donor.dccDonorNumber || donor.donorId,
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
  updateProfile: async (req, res) => {
    try {
      const donor = await donors.findById(req.donor.donorId);
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

      const patch = {};
      if (Object.keys(updates).length) patch.$set = updates;
      if (Object.keys(unset).length) patch.$unset = unset;
      if (!Object.keys(patch).length) {
        return res.status(400).json({ success: false, message: "Nothing to update." });
      }

      await donors.updateById(donor._id, patch);
      res.status(200).json({ success: true, message: "Profile updated." });
    } catch (err) {
      console.error("donor.updateProfile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/my-donations — this donor's full donation history.
  myDonations: async (req, res) => {
    try {
      const rows = await donations.find(
        { donorRecordId: req.donor.donorId },
        {
          sort: { createdAt: -1, _id: 1 },
          lean: true,
          fields: [
            "amount",
            "sevaName",
            "type",
            "status",
            "receiptNumber",
            "createdAt",
            "isRecurring",
            "subscriptionId",
          ],
        }
      );
      res.status(200).json({ success: true, donations: rows });
    } catch (err) {
      console.error("donor.myDonations error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/stats — lifetime giving summary for the dashboard hero:
  stats: async (req, res) => {
    try {
      const donor = await donors.findById(req.donor.donorId, { fields: ["createdAt"], lean: true });
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

      const completed = await donations.find(
        { donorRecordId: req.donor.donorId, status: "completed" },
        { fields: ["amount", "sevaName", "type"], lean: true }
      );

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
  subscriptions: async (req, res) => {
    try {
      const recurring = await donations.find(
        { donorRecordId: req.donor.donorId, isRecurring: true, subscriptionId: { $ne: null } },
        {
          sort: { createdAt: 1, _id: 1 },
          lean: true,
          fields: ["subscriptionId", "amount", "sevaName", "type", "status", "createdAt", "paymentAccount"],
        }
      );

      const bySubscription = new Map();
      for (const d of recurring) {
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
  cancelSubscription: async (req, res) => {
    try {
      const { subscriptionId } = req.params;
      // Ownership check only — NOT used to decide cancellability. Any
      const owned = await donations.findOne(
        { subscriptionId, donorRecordId: req.donor.donorId },
        { sort: { _id: 1 }, fields: ["subscriptionId", "paymentAccount"], lean: true }
      );

      if (!owned) {
        return res.status(404).json({ success: false, message: "Subscription not found." });
      }

      const created = createRazorpayInstance(owned.paymentAccount);
      if (!created) {
        return res
          .status(500)
          .json({ success: false, message: "Payment provider not configured. Please contact us to cancel." });
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
          return res
            .status(400)
            .json({ success: false, message: "This subscription has already run its full course." });
        }
      } catch (fetchErr) {
        console.error("cancelSubscription fetch error:", fetchErr && fetchErr.message ? fetchErr.message : fetchErr);
        return res
          .status(502)
          .json({ success: false, message: "Could not reach the payment provider. Please try again shortly." });
      }

      try {
        await created.instance.subscriptions.cancel(subscriptionId, false);
      } catch (rzpErr) {
        const already = rzpErr && rzpErr.error && /already|cancel/i.test(rzpErr.error.description || "");
        if (!already) {
          console.error("cancelSubscription Razorpay error:", rzpErr && rzpErr.message ? rzpErr.message : rzpErr);
          return res
            .status(502)
            .json({ success: false, message: "Could not reach the payment provider. Please try again shortly." });
        }
      }

      // Best-effort local bookkeeping — flips any record that's still
      await donations.updateMany(
        { subscriptionId, donorRecordId: req.donor.donorId, status: { $nin: ["completed", "cancelled"] } },
        { status: "cancelled" }
      );

      res.status(200).json({ success: true, message: "Your recurring donation has been cancelled." });
    } catch (err) {
      console.error("donor.cancelSubscription error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/my-summary — aggregated stats for the dashboard's graphs:
  mySummary: async (req, res) => {
    try {
      const match = { donorRecordId: castId(req.donor.donorId), status: "completed" };

      const [monthly, bySeva, totals] = await Promise.all([
        aggregate(match, `${istMonth("created_at")} AS k, SUM(amount) AS amount, COUNT(*) AS count`, {
          groupBy: "k",
          orderBy: "k",
        }),
        aggregate(match, "COALESCE(seva_name, 'General') AS k, SUM(amount) AS amount, COUNT(*) AS count", {
          groupBy: "k",
          orderBy: `amount DESC, k COLLATE "C"`,
        }),
        aggregate(match, "COALESCE(SUM(amount), 0) AS total_amount, COUNT(*) AS total_count"),
      ]);

      res.status(200).json({
        success: true,
        monthly: monthly.map((m) => ({ month: m.k, amount: m.amount, count: m.count })),
        bySeva: bySeva.map((s) => ({ sevaName: s.k, amount: s.amount, count: s.count })),
        totals: { totalAmount: Number(totals[0].total_amount) || 0, totalCount: Number(totals[0].total_count) || 0 },
      });
    } catch (err) {
      console.error("donor.mySummary error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/receipt/:donationId — download own receipt PDF. Ownership
  downloadReceipt: async (req, res) => {
    try {
      const donation = await donations.findOne({
        _id: castId(req.params.donationId),
        donorRecordId: req.donor.donorId,
      });
      if (!donation) return res.status(404).json({ success: false, message: "Receipt not found." });
      if (donation.status !== "completed" || !donation.receiptNumber) {
        return res.status(400).json({ success: false, message: "This donation doesn't have a receipt yet." });
      }

      const pdfBytes = await generateReceiptBuffer(donation._id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="receipt-${donation.receiptNumber.replace(/\|/g, "-")}.pdf"`
      );
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("donor.downloadReceipt error:", err);
      res.status(500).json({ success: false, message: "Could not generate receipt." });
    }
  },

  // POST /donor/issues { subject, message } — raise a new issue/query.
  raiseIssue: async (req, res) => {
    try {
      const { subject, message } = req.body;
      if (!subject?.trim() || !message?.trim()) {
        return res.status(400).json({ success: false, message: "Please fill in both subject and message." });
      }
      const issue = await donorIssues.insert({
        donorRecordId: req.donor.donorId,
        subject: subject.trim(),
        message: message.trim(),
      });
      // donorIssue has Mongoose's default versionKey, which the API always exposed.
      res.status(201).json({ success: true, issue: { ...issue, __v: 0 } });
    } catch (err) {
      console.error("donor.raiseIssue error:", err);
      res.status(500).json({ success: false, message: "Could not submit your issue. Please try again." });
    }
  },

  // GET /donor/issues — this donor's own raised issues, with status.
  myIssues: async (req, res) => {
    try {
      const issues = await donorIssues.find(
        { donorRecordId: req.donor.donorId },
        { sort: { createdAt: -1, _id: 1 }, lean: true }
      );
      res.status(200).json({ success: true, issues: issues.map((i) => ({ ...i, __v: 0 })) });
    } catch (err) {
      console.error("donor.myIssues error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

export { donorController };
