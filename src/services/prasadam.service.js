// Maha Prasadam dispatch tracking, scoped by a caller-supplied filter.
//
// Used by the /donations admin (donationAdmin.controller.js), where `scope` is
// the /donations page family. The main admin's Prasadam tab keeps its own
// copy in donation.controller.js and is deliberately not routed through here.
//
// Every record is tracked per DONATION (the donation's own _id), never per
// donor or mobile number: a donor who gives three times and ticks Prasadam
// each time has three separate requests, and marking one dispatched leaves
// the other two exactly as they were.

const { donationModel } = require("../models/donation.model");

const PRASADAM_STATUSES = ["pending", "dispatched", "delivered", "cancelled"];

// Records that pre-date tracking have no prasadamStatus at all, but they ARE
// still waiting to be sent, so "not sent yet" has to include them.
const NOT_SENT_CLAUSE = {
  $or: [{ prasadamStatus: "pending" }, { prasadamStatus: { $exists: false } }, { prasadamStatus: null }],
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Only completed payments with the Prasadam box ticked ever get a courier box.
const baseClause = () => ({ wantPrasadam: true, status: "completed" });

// Builds the full filter as one $and of independent clauses. The scope filter
// and the status/search filters each carry their own $or, so they can never be
// spread into one object: the second $or would silently replace the first.
function buildFilter({ scope, dateMatch, query }) {
  const { status, q, seva, sourcePage } = query || {};
  const clauses = [scope, baseClause()];

  if (dateMatch && Object.keys(dateMatch).length) clauses.push(dateMatch);

  if (status && status !== "all") {
    if (status === "not_dispatched" || status === "pending") clauses.push(NOT_SENT_CLAUSE);
    else clauses.push({ prasadamStatus: status });
  }

  if (seva) clauses.push({ sevaName: seva });
  if (sourcePage) clauses.push({ sourcePage });

  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    clauses.push({
      $or: [
        { donorName: re },
        { donorMobile: re },
        { donorEmail: re },
        { "prasadamAddress.pincode": re },
        { prasadamTrackingNumber: re },
      ],
    });
  }

  return { $and: clauses };
}

async function listRequests({ scope, dateMatch, query }) {
  const filter = buildFilter({ scope, dateMatch, query });
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(query.limit || "20", 10)));
  const skip = (page - 1) * limit;

  // Tab badges and dropdown options come from the whole opt-in set (not the
  // current filters), so the numbers don't change meaning while filtering.
  const optMatch = { $and: [scope, baseClause()] };

  const [total, requests, counts, sevaAgg, pageAgg] = await Promise.all([
    donationModel.countDocuments(filter),
    donationModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select({
        donorName: 1, donorEmail: 1, donorMobile: 1, amount: 1, status: 1,
        wantPrasadam: 1, prasadamAddress: 1,
        prasadamStatus: 1, prasadamCourier: 1, prasadamTrackingNumber: 1,
        prasadamDispatchedAt: 1, prasadamDeliveredAt: 1, prasadamNotes: 1,
        sevaName: 1, type: 1, sourcePage: 1, createdAt: 1,
        razorpayOrderId: 1, razorpayPaymentId: 1, receiptNumber: 1,
      })
      .lean(),
    donationModel.aggregate([{ $match: optMatch }, { $group: { _id: "$prasadamStatus", count: { $sum: 1 } } }]),
    donationModel.aggregate([{ $match: optMatch }, { $group: { _id: "$sevaName" } }, { $sort: { _id: 1 } }]),
    donationModel.aggregate([{ $match: optMatch }, { $group: { _id: "$sourcePage" } }, { $sort: { _id: 1 } }]),
  ]);

  const badgeCounts = { all: 0, pending: 0, dispatched: 0, delivered: 0, cancelled: 0 };
  for (const row of counts) {
    const key = row._id || "pending"; // pre-tracking records count as pending
    if (badgeCounts[key] !== undefined) badgeCounts[key] += row.count;
    badgeCounts.all += row.count;
  }

  return {
    requests,
    total,
    page,
    limit,
    badgeCounts,
    filterOptions: {
      sevas: sevaAgg.map((r) => r._id).filter(Boolean),
      pages: pageAgg.map((r) => r._id).filter(Boolean),
    },
  };
}

// Applies a status change to ONE donation document (does not save). Timestamps
// are set here, server-side, so they can't be forged from the client.
function applyStatusUpdate(donation, body, now = new Date()) {
  const { prasadamStatus, prasadamCourier, prasadamTrackingNumber, prasadamNotes } = body || {};

  donation.prasadamStatus = prasadamStatus;
  if (prasadamCourier !== undefined) donation.prasadamCourier = String(prasadamCourier || "").trim();
  if (prasadamTrackingNumber !== undefined) donation.prasadamTrackingNumber = String(prasadamTrackingNumber || "").trim();
  if (prasadamNotes !== undefined) donation.prasadamNotes = String(prasadamNotes || "").trim();

  if (prasadamStatus === "dispatched") {
    donation.prasadamDispatchedAt = now;
    // A delivered timestamp can't survive a move back to dispatched.
    donation.prasadamDeliveredAt = undefined;
  } else if (prasadamStatus === "delivered") {
    // Allow marking delivered directly (courier confirmed verbally).
    if (!donation.prasadamDispatchedAt) donation.prasadamDispatchedAt = now;
    donation.prasadamDeliveredAt = now;
  } else if (prasadamStatus === "pending" || prasadamStatus === "cancelled") {
    donation.prasadamDispatchedAt = undefined;
    donation.prasadamDeliveredAt = undefined;
  }
  return donation;
}

const csvEscape = (val) => {
  const str = val === null || val === undefined ? "" : String(val);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const formatAddress = (a) =>
  a ? [a.doorNo, a.house, a.street, a.area, a.city, a.state, a.pincode, a.country].filter(Boolean).join(", ") : "";

// CSV for the courier run: one row per donation, same columns as the table.
async function buildCsv({ scope, dateMatch, query }) {
  const filter = buildFilter({ scope, dateMatch, query });
  const rows = await donationModel
    .find(filter)
    .sort({ createdAt: -1 })
    .select(
      "donorName donorEmail donorMobile amount sevaName type sourcePage prasadamAddress prasadamStatus prasadamCourier prasadamTrackingNumber prasadamDispatchedAt prasadamDeliveredAt prasadamNotes receiptNumber razorpayOrderId razorpayPaymentId createdAt"
    )
    .limit(5000)
    .lean();

  const istTime = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "");
  const headers = [
    "Donor Name", "Mobile", "Email", "Amount", "Delivery Address",
    "Seva", "Source Page", "Prasadam Status", "Courier", "Tracking Number",
    "Dispatched At", "Delivered At", "Donated On", "Notes", "Receipt Number", "Payment ID",
  ];
  return [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.donorName || "",
        r.donorMobile || "",
        r.donorEmail || "",
        r.amount,
        formatAddress(r.prasadamAddress),
        r.sevaName || r.type || "",
        r.sourcePage || "",
        r.prasadamStatus || "pending",
        r.prasadamCourier || "",
        r.prasadamTrackingNumber || "",
        istTime(r.prasadamDispatchedAt),
        istTime(r.prasadamDeliveredAt),
        istTime(r.createdAt),
        r.prasadamNotes || "",
        r.receiptNumber || "",
        r.razorpayPaymentId || r.razorpayOrderId || "",
      ].map(csvEscape).join(",")
    ),
  ].join("\n");
}

module.exports = { PRASADAM_STATUSES, buildFilter, listRequests, applyStatusUpdate, buildCsv };
