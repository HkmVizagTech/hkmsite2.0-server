import { donors, donations } from "../db/tables.js";
import { castId } from "../domain/donationQuery.js";
import { defaultsToPersist } from "../domain/donationCast.js";
import { toEnglish } from "../utils/toEnglish.js";
import { sendDonationWhatsAppReceipt } from "../services/paymentCompletion.service.js";
import { donationController } from "./donation.controller.js";
import { generateReceiptBuffer } from "../services/receipt.service.js";

// How long after a receipt goes out another manual resend is refused. Stops a
// double-click or a client retry from sending the donor two WhatsApp messages.
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

const normalizeMobile = (m) =>
  String(m || "")
    .replace(/\s+/g, "")
    .replace(/^\+?91/, "");

const DONATION_FIELDS = [
  "amount",
  "sevaName",
  "type",
  "status",
  "createdAt",
  "isRecurring",
  "subscriptionId",
  "receiptNumber",
  "receiptGeneratedAt",
  "wantPrasadam",
  "prasadamStatus",
  "prasadamCourier",
  "prasadamTrackingNumber",
  "prasadamDispatchedAt",
  "prasadamDeliveredAt",
  "prasadamAddress",
  "donorRecordId",
  // Attribution: which page/campaign on this site produced the gift. DRM
  // splits its totals by these, so they travel with every snapshot.
  "sourcePage",
  "campaignerSlug",
  "utm",
  "razorpayPaymentId",
  "manualEntry",
  "manualPaymentMode",
  "utrNumber",
  "transactionId",
  "dob",
  "sevaDate",
  "sevakName",
];

const ADDRESS_TEXT_FIELDS = ["doorNo", "house", "street", "area", "city", "state", "country"];
function englishAddress(address) {
  if (!address) return null;
  const out = { ...address };
  for (const key of ADDRESS_TEXT_FIELDS) if (out[key] != null) out[key] = toEnglish(out[key]);
  return out;
}

function mapDonation(d) {
  return {
    externalId: String(d._id),
    amount: d.amount,
    type: d.sevaName || d.type || "General",
    status: d.status,
    createdAt: d.createdAt,
    isRecurring: !!d.isRecurring,
    subscriptionId: d.subscriptionId || null,
    receiptNumber: d.receiptNumber || null,
    receiptIssuedAt: d.receiptGeneratedAt || null,
    sourceSite: "hkmv",
    sourcePage: d.sourcePage || null,
    campaign: d.campaignerSlug || (d.utm && d.utm.campaign) || null,
    utm: d.utm
      ? { source: d.utm.source || null, medium: d.utm.medium || null, campaign: d.utm.campaign || null }
      : null,
    paymentRef: d.razorpayPaymentId || d.utrNumber || d.transactionId || null,
    paymentMode: d.manualEntry ? d.manualPaymentMode || "bank" : "online",
    offline: !!d.manualEntry,
    occasion: d.sevaName || d.type || null,
    sevaDate: d.sevaDate || null,
    sevakName: toEnglish(d.sevakName) || null,
    dob: d.dob || null,
    prasadam: d.wantPrasadam
      ? {
          status: d.prasadamStatus || "pending",
          courierName: d.prasadamCourier || null,
          trackingNumber: d.prasadamTrackingNumber || null,
          dispatchedAt: d.prasadamDispatchedAt || null,
          deliveredAt: d.prasadamDeliveredAt || null,
          address: englishAddress(d.prasadamAddress),
        }
      : null,
  };
}

// `donations` (newest first) supplies the date of birth, which this site
// keeps on each donation rather than on the donor.
function mapDonor(donor, donations = []) {
  const withDob = donations.find((d) => d && d.dob);
  return {
    dob: withDob ? String(withDob.dob) : null,
    externalId: String(donor._id),
    donorId: donor.dccDonorNumber || donor.donorId,
    name: toEnglish(donor.name),
    mobile: donor.mobile,
    email: donor.email || null,
    panNumber: donor.panNumber || null,
    savedAddress: englishAddress(donor.savedAddress),
    donorSince: donor.createdAt,
  };
}

function collapseSubscriptions(donations) {
  const bySubscription = new Map();
  for (const d of donations) {
    if (!d.isRecurring || !d.subscriptionId) continue;
    const key = d.subscriptionId;
    if (!bySubscription.has(key)) {
      bySubscription.set(key, {
        subscriptionId: key,
        sevaName: d.sevaName || d.type || "Monthly Seva",
        amount: d.amount,
        status: d.status,
        startedAt: d.createdAt,
        lastChargedAt: d.status === "completed" ? d.createdAt : null,
        chargeCount: d.status === "completed" ? 1 : 0,
      });
    } else {
      const entry = bySubscription.get(key);
      entry.amount = d.amount; // most recent charge amount wins (list is newest-first)
      if (d.status === "completed") {
        entry.chargeCount += 1;
        if (!entry.lastChargedAt || d.createdAt > entry.lastChargedAt) entry.lastChargedAt = d.createdAt;
      }
      if (d.createdAt < entry.startedAt) entry.startedAt = d.createdAt;
    }
  }
  return Array.from(bySubscription.values());
}

// Donor snapshot payload DRM consumes; also used by drmNotify.service.js for the live push.
async function buildDonorSnapshot(donor) {
  const rows = await donations.find(
    { donorRecordId: donor._id },
    { sort: { createdAt: -1, _id: 1 }, fields: DONATION_FIELDS, lean: true }
  );

  return {
    donor: mapDonor(donor, rows),
    donations: rows.map(mapDonation),
    subscriptions: collapseSubscriptions(rows),
  };
}

async function buildDonorSnapshots(donorList) {
  if (!donorList.length) return [];
  const ids = donorList.map((d) => d._id);

  const rows = await donations.find(
    { donorRecordId: { $in: ids } },
    { sort: { createdAt: -1, _id: 1 }, fields: DONATION_FIELDS, lean: true }
  );

  const byDonor = new Map();
  for (const d of rows) {
    const key = String(d.donorRecordId);
    if (!byDonor.has(key)) byDonor.set(key, []);
    byDonor.get(key).push(d);
  }

  return donorList.map((donor) => {
    const own = byDonor.get(String(donor._id)) || [];
    return {
      donor: mapDonor(donor, own),
      donations: own.map(mapDonation),
      subscriptions: collapseSubscriptions(own),
    };
  });
}

const internalController = {
  // GET /api/internal/donors/by-mobile/:mobile
  getDonorByMobile: async (req, res) => {
    try {
      const mobile = normalizeMobile(req.params.mobile);
      if (!mobile) {
        return res.status(400).json({ success: false, message: "Mobile number required" });
      }

      const donor = await donors.findOne({ mobile }, { lean: true });
      if (!donor) return res.json({ success: true, found: false });

      const snapshot = await buildDonorSnapshot(donor);
      res.json({ success: true, found: true, ...snapshot });
    } catch (err) {
      console.error("internal.getDonorByMobile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /api/internal/donors?page=1&limit=50
  listDonors: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const skip = (page - 1) * limit;

      const [donorRows, total] = await Promise.all([
        donors.find({}, { sort: { _id: 1 }, skip, limit, lean: true }),
        donors.count({}),
      ]);

      const snapshots = await buildDonorSnapshots(donorRows);

      res.json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + donorRows.length < total,
        donors: snapshots,
      });
    } catch (err) {
      console.error("internal.listDonors error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // POST /api/internal/donations/:id/resend-receipt
  resendReceipt: async (req, res) => {
    try {
      const donation = await donations.findById(castId(req.params.id));
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });

      if (donation.status !== "completed") {
        return res.status(400).json({ success: false, message: "Only completed donations have a receipt to send." });
      }
      if (!donation.receiptNumber) {
        return res.status(409).json({
          success: false,
          message: "This donation has no receipt number yet (DCC sync hasn't completed), so there is nothing to send.",
        });
      }
      if (!donation.donorMobile) {
        return res.status(400).json({ success: false, message: "This donation has no mobile number to send to." });
      }

      // Refuse a second send inside the cooldown (force:true would otherwise send twice).
      const lastSent = donation.whatsappReceiptSentAt ? new Date(donation.whatsappReceiptSentAt) : null;
      if (lastSent && Date.now() - lastSent.getTime() < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastSent.getTime())) / 1000);
        return res.status(429).json({
          success: false,
          alreadySent: true,
          message: `This receipt went out ${Math.round((Date.now() - lastSent.getTime()) / 1000)}s ago. Try again in ${waitSec}s if the donor still hasn't received it.`,
        });
      }

      const result = await sendDonationWhatsAppReceipt(donation, { force: true });

      if (!result || result.ok === false) {
        return res.status(502).json({
          success: false,
          message: (result && (result.reason || result.error)) || "WhatsApp provider rejected the send.",
        });
      }

      res.json({
        success: true,
        sentTo: donation.donorMobile,
        receiptNumber: donation.receiptNumber,
      });
    } catch (err) {
      console.error("internal.resendReceipt error:", err);
      res.status(500).json({ success: false, message: "Could not resend the receipt." });
    }
  },

  // POST /api/internal/drm/donations/offline
  createOfflineDonation: async (req, res) => {
    const enteredByNote = req.body?.enteredByName
      ? `Entered in DRM by ${String(req.body.enteredByName).slice(0, 80)}`
      : "Entered in DRM";
    const note = req.body?.manualEntryNote ? `${req.body.manualEntryNote} (${enteredByNote})` : enteredByNote;

    // Minimal req standing in for the logged-in request createManual expects (role admin: no preacher is assigned).
    const fakeReq = {
      body: { ...req.body, manualEntryNote: note },
      user: { role: "admin" },
    };

    return donationController.createManual(fakeReq, res);
  },

  // PUT /api/internal/drm/donations/:id/prasadam-status
  updatePrasadamStatus: async (req, res) => {
    const DRM_TO_SITE = {
      pending: "pending",
      shipped: "dispatched",
      dispatched: "dispatched",
      delivered: "delivered",
      cancelled: "cancelled",
    };
    const incoming = String(req.body?.status || req.body?.prasadamStatus || "").toLowerCase();
    const prasadamStatus = DRM_TO_SITE[incoming];
    if (!prasadamStatus) {
      return res.status(400).json({
        success: false,
        message: "status must be one of: pending, shipped, delivered, cancelled",
      });
    }

    const who = req.body?.markedByName ? String(req.body.markedByName).slice(0, 80) : null;
    const existingNote = req.body?.notes ? String(req.body.notes).slice(0, 400) : "";
    const trail = who ? `Marked ${incoming} in DRM by ${who}` : `Marked ${incoming} in DRM`;

    const fakeReq = {
      params: { id: req.params.id },
      body: {
        prasadamStatus,
        prasadamCourier: req.body?.courierName,
        prasadamTrackingNumber: req.body?.trackingNumber,
        prasadamNotes: existingNote ? `${existingNote} (${trail})` : trail,
      },
    };

    return donationController.updatePrasadamStatus(fakeReq, res);
  },

  // GET /api/internal/drm/abandoned?since=&page=&limit=
  getAbandonedDonations: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
      // No lower than 3: DRM asks from 5, after the site's 3-minute reminder.
      const minMinutes = Math.max(3, parseInt(req.query.minMinutes, 10) || 60);

      const cutoff = new Date(Date.now() - minMinutes * 60 * 1000);
      const filter = {
        donorMobile: { $exists: true, $ne: "" },
        $or: [{ status: "failed" }, { status: "pending", createdAt: { $lte: cutoff } }],
      };
      if (req.query.since) {
        const since = new Date(req.query.since);
        if (!Number.isNaN(since.getTime())) filter.createdAt = { $gte: since };
      }

      const [rows, total] = await Promise.all([
        donations.find(filter, {
          sort: { createdAt: -1, _id: 1 },
          skip: (page - 1) * limit,
          limit,
          lean: true,
          fields: [
            "donorName",
            "donorMobile",
            "donorEmail",
            "amount",
            "sevaName",
            "type",
            "sourcePage",
            "status",
            "createdAt",
          ],
        }),
        donations.count(filter),
      ]);

      res.status(200).json({
        success: true,
        page,
        limit,
        total,
        hasMore: page * limit < total,
        donations: rows.map((d) => ({
          externalId: String(d._id),
          name: d.donorName || null,
          mobile: d.donorMobile || null,
          email: d.donorEmail || null,
          amount: d.amount ?? null,
          purpose: d.sevaName || d.type || null,
          sourcePage: d.sourcePage || null,
          status: d.status,
          attemptedAt: d.createdAt,
          sourceSite: "hkmv",
        })),
      });
    } catch (err) {
      console.error("internal.getAbandonedDonations error:", err);
      res.status(500).json({ success: false, message: err.message || "Failed to list abandoned donations" });
    }
  },

  // GET /api/internal/donations/:id/receipt.pdf
  getReceiptPdf: async (req, res) => {
    try {
      const donation = await donations.findById(castId(req.params.id));
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });
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
      console.error("internal.getReceiptPdf error:", err);
      res.status(500).json({ success: false, message: "Could not generate receipt." });
    }
  },

  // PUT /api/internal/drm/donors/by-mobile/:mobile/profile
  updateDonorProfile: async (req, res) => {
    try {
      const mobile = normalizeMobile(req.params.mobile);
      if (!mobile) {
        return res.status(400).json({ success: false, message: "Mobile number required" });
      }

      const donor = await donors.findOne({ mobile });
      if (!donor) {
        // Not an error. DRM asked us to correct somebody we have never heard
        // of, and the honest answer is "nothing to correct here".
        return res.json({ success: true, applied: false, message: "No donor with that mobile on this site." });
      }

      const { name, email, panNumber, address } = req.body || {};
      const changed = [];
      const patch = {};

      if (typeof name === "string" && name.trim() && name.trim() !== donor.name) {
        patch.name = name.trim().slice(0, 120);
        changed.push("name");
      }
      if (typeof email === "string") {
        const e = email.trim();
        if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e !== donor.email) {
          patch.email = e;
          changed.push("email");
        }
      }
      if (typeof panNumber === "string" && panNumber.trim()) {
        const pan = panNumber.trim().toUpperCase();
        if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) && pan !== donor.panNumber) {
          patch.panNumber = pan;
          changed.push("panNumber");
        }
      }

      if (address && typeof address === "object") {
        const street = String(address.street || "").trim();
        const city = String(address.city || "").trim();
        const state = String(address.state || "").trim();
        const pincode = String(address.pincode || "").trim();
        const country = String(address.country || "India").trim() || "India";

        if (street || city || state || pincode) {
          patch.savedAddress = { street, city, state, pincode, country };
          changed.push("address");
        }
      }

      if (!changed.length) {
        return res.json({ success: true, applied: false, message: "Nothing here differed." });
      }

      const raw = await donors.findById(donor._id, { lean: true });
      await donors.updateById(donor._id, { ...defaultsToPersist(raw, donor, ["savedAddress"]), ...patch });
      res.json({ success: true, applied: true, changed, message: `Updated ${changed.join(", ")}.` });
    } catch (err) {
      console.error("internal.updateDonorProfile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

export { internalController, buildDonorSnapshot };
