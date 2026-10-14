import axios from "axios";

const HTTP_TIMEOUT_MS = Number(process.env.TRACKING_HTTP_TIMEOUT_MS || 8000);

const TRACKING_URL_BUILDERS = {
  delhivery: (n) => `https://track.delhivery.com/?awb=${encodeURIComponent(n)}`,
  dtdc: (n) => `https://www.dtdc.in/tracking.asp?strCnno=${encodeURIComponent(n)}`,
  bluedart: (n) => `https://www.bluedart.com/tracking?loc=awb&awb=${encodeURIComponent(n)}`,
  "india post": (n) =>
    `https://www.indiapost.gov.in/vas/Pages/custconsignment.aspx?appid=consignment&cnno=${encodeURIComponent(n)}`,
  indiapost: (n) => TRACKING_URL_BUILDERS["india post"](n),
  ekart: (n) => `https://ekartlogistics.com/shipmenttrack/${encodeURIComponent(n)}`,
  xpressbees: (n) => `https://www.xpressbees.com/shipment/tracking?awb=${encodeURIComponent(n)}`,
};

const DETECT_RULES = [
  { courier: "India Post", test: (n) => /^[A-Z]{2}\d{9}IN$/.test(n) },
  { courier: "Delhivery", test: (n) => /^\d{12}$/.test(n) },
  { courier: "Bluedart", test: (n) => /^\d{9}$/.test(n) },
  // Letter-prefixed alphanumeric — DTDC's most common waybill shape. Kept
  // after the exact matches above so it only catches the leftovers.
  { courier: "DTDC", test: (n) => /^[A-Z]\d{8,11}$/.test(n) || /^[A-Z]{2}\d{7,10}$/.test(n) },
];

function detectCourier(trackingNumber) {
  const n = String(trackingNumber || "")
    .trim()
    .toUpperCase();
  if (!n) return "";
  for (const rule of DETECT_RULES) {
    if (rule.test(n)) return rule.courier;
  }
  return "";
}

/** Normalise a courier name ("delhivery", "Delhivery " → "delhivery"). */
function normalizeCourierKey(courier) {
  return String(courier || "")
    .trim()
    .toLowerCase();
}

function buildTrackingUrl(courier, trackingNumber) {
  const n = String(trackingNumber || "").trim();
  if (!n) return "";
  const builder = TRACKING_URL_BUILDERS[normalizeCourierKey(courier)];
  return builder ? builder(n) : "";
}

// Words that mean the parcel has been handed to / is moving with the courier.
const IN_TRANSIT_WORDS = [
  "in transit",
  "intransit",
  "transit",
  "dispatched",
  "departed",
  "in flight",
  "connection",
  "arrived at",
  "reached",
  "bagged",
  "manifested",
  "picked up",
  "shipped",
  "movement",
  "line haul",
  "out for delivery",
];

// Words that mean it's on the vehicle for the final run today.
const OUT_FOR_DELIVERY_WORDS = ["out for delivery", "ofd", "out for del"];

// Words that mean the customer has it.
const DELIVERED_WORDS = [
  "delivered",
  "delivered.",
  "shipment delivered",
  "consignment delivered",
  "delivery confirmed",
  "received by",
];

// Words that mean it isn't going to arrive without intervention.
const EXCEPTION_WORDS = [
  "undelivered",
  "rto",
  "return to origin",
  "returned",
  "lost",
  "damaged",
  "refused",
  "not reachable",
  "customer not available",
  "unDeliverable".toLowerCase(),
];

function matchesAny(statusText, words) {
  const s = String(statusText || "").toLowerCase();
  return words.some((w) => s.includes(w));
}

function mapCourierStatusToOrderStatus(statusText) {
  const s = String(statusText || "");
  if (!s) return "";
  if (matchesAny(s, DELIVERED_WORDS)) return "delivered";
  if (matchesAny(s, EXCEPTION_WORDS)) return "exception";
  if (matchesAny(s, OUT_FOR_DELIVERY_WORDS)) return "out_for_delivery";
  if (matchesAny(s, IN_TRANSIT_WORDS)) return "in_transit";
  return "";
}

const DELHIVERY_API_KEY = process.env.DELHIVERY_TRACKING_API_KEY || "";

async function fetchDelhiveryStatus(trackingNumber) {
  const headers = {};
  if (DELHIVERY_API_KEY) headers.Authorization = `Token ${DELHIVERY_API_KEY}`;
  const res = await axios.get(
    `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(trackingNumber)}`,
    { headers, timeout: HTTP_TIMEOUT_MS }
  );
  const pkg = res.data?.DeliveryData?.[0] || res.data?.PackageList?.[0];
  if (!pkg) return { status: "" };
  // Delhivery exposes both a machine field and human text — prefer the human
  // text since our word matching is built for it.
  return { status: pkg.Status || pkg.StatusText || "" };
}

async function fetchDtdcStatus(trackingNumber) {
  // DTDC's newer JSON tracking endpoint (works without a key for basic
  // tracking; add DTDC_TRACKING_API_KEY when DTDC requires one).
  const headers = {};
  const key = process.env.DTDC_TRACKING_API_KEY || "";
  if (key) headers["api-key"] = key;
  const res = await axios.get(
    `https://trackapi.thirdutc.com/api/consignment?cnno=${encodeURIComponent(trackingNumber)}`,
    { headers, timeout: HTTP_TIMEOUT_MS }
  );
  const data = res.data || {};
  const scan = Array.isArray(data.trackDetails) ? data.trackDetails[0] : null;
  const status =
    data.consignmentStatus ||
    (scan && (scan.strStatus || scan.status)) ||
    (data.trackerData && data.trackerData.status) ||
    "";
  return { status: String(status || "") };
}

async function fetchBluedartStatus(trackingNumber) {
  // Bluedart requires a licensed key (BLUEDART_API_KEY) + login ID.
  const licenseKey = process.env.BLUEDART_API_KEY || "";
  const loginId = process.env.BLUEDART_LOGIN_ID || "";
  if (!licenseKey || !loginId) return { status: "" }; // not configured — skip silently
  const res = await axios.post(
    "https://netconnect.bluedart.com/ShippingApi1.2/Tracking/RouteXML",
    {
      Profile: { LoginID: loginId, LicenseKey: licenseKey, Server_Env: "PROD", Version: "1.3" },
      data: {
        WaybillNums: [{ WaybillNo: trackingNumber }],
        IsTwoWayCallRequired: false,
      },
    },
    { timeout: HTTP_TIMEOUT_MS }
  );
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  // The XML/JSON response carries <Status>Delivered</Status>-style text; a
  // light regex keeps us free of an XML parser dependency.
  const m = text.match(/<Status>\s*([^<]+?)\s*<\/Status>/i);
  return { status: m ? m[1] : "" };
}

async function fetchIndiaPostStatus(trackingNumber) {
  // India Post's public tracking JSON endpoint (no key needed).
  const res = await axios.get(
    `https://clsapi.indiapost.gov.in/TrackConsignmentSimpleServlet?clone=false&token=&uidType=consignment&cnno=${encodeURIComponent(
      trackingNumber
    )}&Submit=Track`,
    { timeout: HTTP_TIMEOUT_MS, responseType: "json" }
  );
  const data = res.data;
  // Response shape varies; pull the most recent event's description.
  const events = data?.TrackConsignmentTrackDetails?.TrackDetail || data?.TrackDetail || [];
  const arr = Array.isArray(events) ? events : [events];
  const latest = arr[arr.length - 1];
  const status = latest?.EventDescription || latest?.eventDescription || "";
  return { status: String(status || "") };
}

const COURIER_FETCHERS = {
  delhivery: fetchDelhiveryStatus,
  dtdc: fetchDtdcStatus,
  bluedart: fetchBluedartStatus,
  "india post": fetchIndiaPostStatus,
  indiapost: fetchIndiaPostStatus,
};

async function fetchCourierStatus(courier, trackingNumber) {
  const n = String(trackingNumber || "").trim();
  if (!n) return { status: "" };
  const fetcher = COURIER_FETCHERS[normalizeCourierKey(courier)];
  if (!fetcher) return { status: "" };
  try {
    return await fetcher(n);
  } catch (err) {
    console.warn(
      `tracking.service: ${courier} status check failed for ${n}:`,
      err && err.response && err.response.status
        ? `HTTP ${err.response.status}`
        : err && err.message
          ? err.message
          : err
    );
    return { status: "" };
  }
}

export {
  detectCourier,
  buildTrackingUrl,
  mapCourierStatusToOrderStatus,
  fetchCourierStatus, // Exposed for tests/debugging.
  TRACKING_URL_BUILDERS,
  DETECT_RULES,
};
