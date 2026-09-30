const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");

// How long after a receipt goes out another manual resend is refused. Stops a
// double-click or a client retry from sending the donor two WhatsApp messages.
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

const normalizeMobile = (m) => String(m || "").replace(/\s+/g, "").replace(/^\+?91/, "");

// Fields DRM needs from a donation. Kept in one place so the by-mobile
// endpoint, the paginated backfill list, and the live push to DRM can never
// drift apart on what they select.
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
].join(" ");

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
    paymentRef: d.razorpayPaymentId || null,
    prasadam: d.wantPrasadam
      ? {
          status: d.prasadamStatus || "pending",
          courierName: d.prasadamCourier || null,
          trackingNumber: d.prasadamTrackingNumber || null,
          dispatchedAt: d.prasadamDispatchedAt || null,
          deliveredAt: d.prasadamDeliveredAt || null,
          address: d.prasadamAddress || null,
        }
      : null,
  };
}

function mapDonor(donor) {
  return {
    externalId: String(donor._id),
    donorId: donor.dccDonorNumber || donor.donorId,
    name: donor.name,
    mobile: donor.mobile,
    email: donor.email || null,
    panNumber: donor.panNumber || null,
    savedAddress: donor.savedAddress || null,
    donorSince: donor.createdAt,
  };
}

// Collapse recurring donations into one entry per Razorpay subscriptionId -
// the same grouping donor.controller.js's GET /donor/subscriptions uses.
// `donations` must be sorted newest-first.
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

// Builds the donor snapshot payload DRM consumes. Exported because
// drmNotify.service.js pushes this exact same shape to DRM the moment a
// donation completes - so DRM has ONE idempotent upsert path that handles
// both the pull (sync/backfill) and the push (live webhook) identically.
async function buildDonorSnapshot(donor) {
  const donations = await donationModel
    .find({ donorRecordId: donor._id })
    .sort({ createdAt: -1 })
    .select(DONATION_FIELDS)
    .lean();

  return {
    donor: mapDonor(donor),
    donations: donations.map(mapDonation),
    subscriptions: collapseSubscriptions(donations),
  };
}

// Batch version for the backfill list: one donations query for the whole
// page instead of one per donor, so importing thousands of donors doesn't
// turn into thousands of round trips.
async function buildDonorSnapshots(donors) {
  if (!donors.length) return [];
  const ids = donors.map((d) => d._id);

  const donations = await donationModel
    .find({ donorRecordId: { $in: ids } })
    .sort({ createdAt: -1 })
    .select(DONATION_FIELDS)
    .lean();

  const byDonor = new Map();
  for (const d of donations) {
    const key = String(d.donorRecordId);
    if (!byDonor.has(key)) byDonor.set(key, []);
    byDonor.get(key).push(d);
  }

  return donors.map((donor) => {
    const own = byDonor.get(String(donor._id)) || [];
    return {
      donor: mapDonor(donor),
      donations: own.map(mapDonation),
      subscriptions: collapseSubscriptions(own),
    };
  });
}

const internalController = {
  // GET /api/internal/donors/by-mobile/:mobile
  // Server-to-server snapshot for the HKM Vizag DRM (donor relationship
  // manager, a separate PostgreSQL/Express app) to sync a donor's identity,
  // donation/receipt history, recurring subscriptions, and prasadam
  // delivery status. Protected by x-internal-secret, the same convention
  // already used by the other /api/internal routes in app.js - this is a
  // service call, not a logged-in donor session, so donorAuthMiddleware
  // does not apply here.
  //
  // Note this does NOT call out to Razorpay for live subscription status -
  // DRM's sync is meant to be cheap to run often. The locally-derived
  // status (from the most recent donation for that subscription) is a fine
  // approximation; if it ever needs to be authoritative, add a `live=true`
  // query flag that opts into the same Razorpay lookup donor.controller.js
  // does.
  getDonorByMobile: async (req, res) => {
    try {
      const mobile = normalizeMobile(req.params.mobile);
      if (!mobile) {
        return res.status(400).json({ success: false, message: "Mobile number required" });
      }

      const donor = await donorModel.findOne({ mobile }).lean();
      if (!donor) return res.json({ success: true, found: false });

      const snapshot = await buildDonorSnapshot(donor);
      res.json({ success: true, found: true, ...snapshot });
    } catch (err) {
      console.error("internal.getDonorByMobile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /api/internal/donors?page=1&limit=50
  // Paginated firehose of every donor with their full history, so DRM can
  // backfill an empty database (and re-run it later to catch up). Ordered by
  // _id so paging stays stable even while new donors are being created
  // mid-import - an offset sort on createdAt would shift rows between pages.
  listDonors: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const skip = (page - 1) * limit;

      const [donors, total] = await Promise.all([
        donorModel.find({}).sort({ _id: 1 }).skip(skip).limit(limit).lean(),
        donorModel.countDocuments({}),
      ]);

      const snapshots = await buildDonorSnapshots(donors);

      res.json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + donors.length < total,
        donors: snapshots,
      });
    } catch (err) {
      console.error("internal.listDonors error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // POST /api/internal/donations/:id/resend-receipt
  //
  // Re-sends the WhatsApp receipt for one donation, so staff can do it from
  // DRM when a donor says they never got it - rather than asking someone to
  // open the admin panel on this site.
  //
  // Reuses sendDonationWhatsAppReceipt with force:true, which is the same
  // path the existing bulk resend uses; force bypasses the
  // "already sent" guard that would otherwise make a deliberate resend a
  // silent no-op.
  resendReceipt: async (req, res) => {
    try {
      const donation = await donationModel.findById(req.params.id);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });

      if (donation.status !== "completed") {
        return res.status(400).json({ success: false, message: "Only completed donations have a receipt to send." });
      }
      if (!donation.receiptNumber) {
        return res
          .status(409)
          .json({ success: false, message: "This donation has no receipt number yet (DCC sync hasn't completed), so there is nothing to send." });
      }
      if (!donation.donorMobile) {
        return res.status(400).json({ success: false, message: "This donation has no mobile number to send to." });
      }

      // Idempotency guard.
      //
      // sendDonationWhatsAppReceipt has its own "already sent" lock, but we
      // call it with force:true - which is the whole point of a resend, and
      // also means it will happily send twice if asked twice. So refuse a
      // second send inside the cooldown, based on when the last one actually
      // went out.
      const lastSent = donation.whatsappReceiptSentAt ? new Date(donation.whatsappReceiptSentAt) : null;
      if (lastSent && Date.now() - lastSent.getTime() < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastSent.getTime())) / 1000);
        return res.status(429).json({
          success: false,
          alreadySent: true,
          message: `This receipt went out ${Math.round((Date.now() - lastSent.getTime()) / 1000)}s ago. Try again in ${waitSec}s if the donor still hasn't received it.`,
        });
      }

      const { sendDonationWhatsAppReceipt } = require("../services/paymentCompletion.service");
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
  //
  // Records a donation taken offline (cash, cheque, UPI, bank transfer) that
  // was entered in DRM rather than on this site's own admin screen.
  //
  // It does NOT reimplement anything. It hands straight to
  // donationController.createManual - the same "raise receipt" path a preacher
  // uses here - so the donation goes through the identical DCC sync, receipt
  // numbering and WhatsApp delivery. There is one receipt series on this site,
  // and DRM never mints a number of its own.
  //
  // The only thing this wrapper changes is HOW the caller is authenticated:
  // createManual's own route sits behind a preacher login, and DRM has a shared
  // secret instead. Everything else - the required UTR, the duplicate-reference
  // guard, the validation - is inherited untouched, so a bug fixed there is
  // fixed for both callers.
  createOfflineDonation: async (req, res) => {
    const { donationController } = require("./donation.controller");

    // Who typed it in DRM travels as a note rather than manualEnteredBy: that
    // field references a user in THIS database, and a DRM user id would be a
    // dangling reference.
    const enteredByNote = req.body?.enteredByName
      ? `Entered in DRM by ${String(req.body.enteredByName).slice(0, 80)}`
      : "Entered in DRM";
    const note = req.body?.manualEntryNote
      ? `${req.body.manualEntryNote} (${enteredByNote})`
      : enteredByNote;

    // A minimal req standing in for the logged-in preacher request createManual
    // normally receives. role "admin" (not "preacher") on purpose: a DRM entry
    // has no preacher behind it, and passing one would wrongly assign this
    // donor to whoever happened to be logged in.
    const fakeReq = {
      body: { ...req.body, manualEntryNote: note },
      user: { role: "admin" },
    };

    return donationController.createManual(fakeReq, res);
  },

  // PUT /api/internal/drm/donations/:id/prasadam-status
  //
  // DRM is where the temple staff now work the prasadam dispatch list, so the
  // status they set there has to reach this site too - otherwise the Prasadam
  // tab here keeps showing boxes as pending long after they were delivered,
  // and whoever opens it next re-couriers them.
  //
  // Delegates to donation.controller.updatePrasadamStatus, which owns the
  // timestamp rules (dispatched clears deliveredAt, delivered backfills
  // dispatchedAt, and so on). Duplicating those here is how the two copies
  // would drift.
  //
  // DRM's vocabulary differs by one word: it says "shipped" where this site
  // says "dispatched". Translating here rather than in DRM keeps the mapping
  // next to the model it is mapping onto.
  updatePrasadamStatus: async (req, res) => {
    const { donationController } = require("./donation.controller");

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
  //
  // People who started a donation here and never finished it. The temple calls
  // them: most abandoned payments are a failed UPI app or a distracted donor,
  // not a change of heart, and a call recovers a good share of them.
  //
  // WHY minMinutes EXISTS: a donation sits in "pending" for the whole time the
  // donor is on the payment page. Handing DRM a record that is ninety seconds
  // old would mean calling someone who is still typing their UPI PIN. Default
  // is an hour; DRM can ask for more.
  //
  // This does NOT decide whether the person later gave successfully - DRM holds
  // every completed donation from both sites and is the only place that can
  // answer that across sites, so the filtering happens there.
  getAbandonedDonations: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const minMinutes = Math.max(15, parseInt(req.query.minMinutes, 10) || 60);

      const filter = {
        status: { $in: ["pending", "failed"] },
        createdAt: { $lte: new Date(Date.now() - minMinutes * 60 * 1000) },
        donorMobile: { $exists: true, $ne: "" },
      };
      if (req.query.since) {
        const since = new Date(req.query.since);
        if (!Number.isNaN(since.getTime())) filter.createdAt.$gte = since;
      }

      const [rows, total] = await Promise.all([
        donationModel
          .find(filter)
          .select("donorName donorMobile donorEmail amount sevaName type sourcePage status createdAt")
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        donationModel.countDocuments(filter),
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
  // Streams the same 80G receipt PDF a logged-in donor would get from
  // GET /donor/receipt/:donationId, so DRM can show/download the real
  // receipt instead of duplicating PDF generation on its own side.
  getReceiptPdf: async (req, res) => {
    try {
      const donation = await donationModel.findById(req.params.id);
      if (!donation) return res.status(404).json({ success: false, message: "Donation not found" });
      if (donation.status !== "completed" || !donation.receiptNumber) {
        return res.status(400).json({ success: false, message: "This donation doesn't have a receipt yet." });
      }

      const { generateReceiptBuffer } = require("../services/receipt.service");
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
  //
  // A correction made in DRM, pushed here.
  //
  // WHY THIS EXISTS
  // Three systems hold a donor's details - this site, annadan, and DRM - and
  // until now the traffic was one-way. A staff member who fixed a misspelt
  // name or a wrong address in DRM fixed it only in DRM, and this site kept
  // printing the old one on every receipt.
  //
  // WHAT IT WILL AND WILL NOT DO
  // It updates the donor record, and deliberately not past donations. A
  // donation carries the name and address as they were when the receipt was
  // issued, and rewriting those would make issued 80G receipts disagree with
  // the records behind them. New donations pick the corrected details up
  // because they are copied from the donor at the time.
  //
  // A donor who has never given here is not created. DRM only pushes to sites
  // a donor is already known to, and inventing a donor record from a sync
  // would be a surprising thing for a sync to do.
  updateDonorProfile: async (req, res) => {
    try {
      const mobile = normalizeMobile(req.params.mobile);
      if (!mobile) {
        return res.status(400).json({ success: false, message: "Mobile number required" });
      }

      const donor = await donorModel.findOne({ mobile });
      if (!donor) {
        // Not an error. DRM asked us to correct somebody we have never heard
        // of, and the honest answer is "nothing to correct here".
        return res.json({ success: true, applied: false, message: "No donor with that mobile on this site." });
      }

      const { name, email, panNumber, address } = req.body || {};
      const changed = [];

      if (typeof name === "string" && name.trim() && name.trim() !== donor.name) {
        donor.name = name.trim().slice(0, 120);
        changed.push("name");
      }
      if (typeof email === "string") {
        const e = email.trim();
        if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e !== donor.email) {
          donor.email = e;
          changed.push("email");
        }
      }
      if (typeof panNumber === "string" && panNumber.trim()) {
        const pan = panNumber.trim().toUpperCase();
        if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) && pan !== donor.panNumber) {
          donor.panNumber = pan;
          changed.push("panNumber");
        }
      }

      // savedAddress is the five-field shape this site uses. DRM folds its
      // door/house/area parts into street before sending, because a shape
      // mismatch must not cost a donor their flat number.
      if (address && typeof address === "object") {
        const street = String(address.street || "").trim();
        const city = String(address.city || "").trim();
        const state = String(address.state || "").trim();
        const pincode = String(address.pincode || "").trim();
        const country = String(address.country || "India").trim() || "India";

        if (street || city || state || pincode) {
          donor.savedAddress = { street, city, state, pincode, country };
          changed.push("address");
        }
      }

      if (!changed.length) {
        return res.json({ success: true, applied: false, message: "Nothing here differed." });
      }

      await donor.save();
      res.json({ success: true, applied: true, changed, message: `Updated ${changed.join(", ")}.` });
    } catch (err) {
      console.error("internal.updateDonorProfile error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

module.exports = { internalController, buildDonorSnapshot };
