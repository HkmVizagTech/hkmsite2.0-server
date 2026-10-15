import { donations } from "../db/tables.js";
import { castFilter } from "../domain/donationCast.js";
import { aggregate } from "../domain/donationQuery.js";

export const PRASADAM_STATUSES = ["pending", "dispatched", "delivered", "cancelled"];

const BY_NEWEST = { createdAt: -1, _id: 1 };

const NOT_SENT_CLAUSE = {
  $or: [{ prasadamStatus: "pending" }, { prasadamStatus: { $exists: false } }, { prasadamStatus: null }],
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const baseClause = () => ({ wantPrasadam: true, status: "completed" });

const LIST_FIELDS = [
  "donorName",
  "donorEmail",
  "donorMobile",
  "amount",
  "status",
  "wantPrasadam",
  "prasadamAddress",
  "prasadamStatus",
  "prasadamCourier",
  "prasadamTrackingNumber",
  "prasadamDispatchedAt",
  "prasadamDeliveredAt",
  "prasadamNotes",
  "sevaName",
  "type",
  "sourcePage",
  "createdAt",
  "razorpayOrderId",
  "razorpayPaymentId",
  "receiptNumber",
];

const CSV_FIELDS = [
  "donorName",
  "donorEmail",
  "donorMobile",
  "amount",
  "sevaName",
  "type",
  "sourcePage",
  "prasadamAddress",
  "prasadamStatus",
  "prasadamCourier",
  "prasadamTrackingNumber",
  "prasadamDispatchedAt",
  "prasadamDeliveredAt",
  "prasadamNotes",
  "receiptNumber",
  "razorpayOrderId",
  "razorpayPaymentId",
  "createdAt",
];

export function buildFilter({ scope, dateMatch, query }) {
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

export async function listRequests({ scope, dateMatch, query }) {
  const filter = castFilter(buildFilter({ scope, dateMatch, query }));
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(query.limit || "20", 10)));
  const skip = (page - 1) * limit;
  // Mongoose ignored a NaN skip or limit.
  const pageOpts = { skip: Number.isNaN(skip) ? 0 : skip, limit: Number.isNaN(limit) ? undefined : limit };

  const optMatch = { $and: [scope, baseClause()] };

  const [total, requests, counts, sevaAgg, pageAgg] = await Promise.all([
    donations.count(filter),
    donations.find(filter, { sort: BY_NEWEST, ...pageOpts, fields: LIST_FIELDS, lean: true }),
    aggregate(optMatch, "prasadam_status AS k, COUNT(*) AS count", { groupBy: "k" }),
    aggregate(optMatch, "seva_name AS k", { groupBy: "k", orderBy: `k COLLATE "C"` }),
    aggregate(optMatch, "source_page AS k", { groupBy: "k", orderBy: `k COLLATE "C"` }),
  ]);

  const badgeCounts = { all: 0, pending: 0, dispatched: 0, delivered: 0, cancelled: 0 };
  for (const row of counts) {
    const key = row.k || "pending";
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
      sevas: sevaAgg.map((r) => r.k).filter(Boolean),
      pages: pageAgg.map((r) => r.k).filter(Boolean),
    },
  };
}

// Returns a copy of `donation` with the status change applied; unset fields are `undefined` like on a Mongoose document.
export function applyStatusUpdate(donation, body, now = new Date()) {
  const { prasadamStatus, prasadamCourier, prasadamTrackingNumber, prasadamNotes } = body || {};
  const next = { ...donation };

  next.prasadamStatus = prasadamStatus;
  if (prasadamCourier !== undefined) next.prasadamCourier = String(prasadamCourier || "").trim();
  if (prasadamTrackingNumber !== undefined) next.prasadamTrackingNumber = String(prasadamTrackingNumber || "").trim();
  if (prasadamNotes !== undefined) next.prasadamNotes = String(prasadamNotes || "").trim();

  if (prasadamStatus === "dispatched") {
    next.prasadamDispatchedAt = now;
    next.prasadamDeliveredAt = undefined;
  } else if (prasadamStatus === "delivered") {
    if (!next.prasadamDispatchedAt) next.prasadamDispatchedAt = now;
    next.prasadamDeliveredAt = now;
  } else if (prasadamStatus === "pending" || prasadamStatus === "cancelled") {
    next.prasadamDispatchedAt = undefined;
    next.prasadamDeliveredAt = undefined;
  }
  return next;
}

const csvEscape = (val) => {
  const str = val === null || val === undefined ? "" : String(val);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const formatAddress = (a) =>
  a ? [a.doorNo, a.house, a.street, a.area, a.city, a.state, a.pincode, a.country].filter(Boolean).join(", ") : "";

export async function buildCsv({ scope, dateMatch, query }) {
  const filter = castFilter(buildFilter({ scope, dateMatch, query }));
  const rows = await donations.find(filter, { sort: BY_NEWEST, limit: 5000, lean: true, fields: CSV_FIELDS });

  const istTime = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "");
  const headers = [
    "Donor Name",
    "Mobile",
    "Email",
    "Amount",
    "Delivery Address",
    "Seva",
    "Source Page",
    "Prasadam Status",
    "Courier",
    "Tracking Number",
    "Dispatched At",
    "Delivered At",
    "Donated On",
    "Notes",
    "Receipt Number",
    "Payment ID",
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
      ]
        .map(csvEscape)
        .join(",")
    ),
  ].join("\n");
}
