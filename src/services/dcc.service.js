const { donationModel } = require("../models/donation.model");

const DCC_API_URL = process.env.DCC_API_URL || "https://vhkmsurabhi.com/api/socialmedia/addDonation";

const DCC_PAYMENT_MODES = {
  online: Number(process.env.DCC_MODE_ONLINE || 3),
  cash: Number(process.env.DCC_MODE_CASH || 1),
  cheque: Number(process.env.DCC_MODE_CHEQUE || 2),
  upi: Number(process.env.DCC_MODE_UPI || 3),
  bank: Number(process.env.DCC_MODE_BANK || 4),
};

const DEFAULT_SEVA_MAPPING = {
  sevaCategory: Number(process.env.DCC_SEVA_CATEGORY || 24),
  sevaSubCategory: Number(process.env.DCC_SEVA_SUBCATEGORY || 115),
  sevaSubCategoryCode: process.env.DCC_SEVA_SUBCATEGORY_CODE || null,
};

const parseJsonEnv = (name, fallback) => {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn(`Invalid JSON in ${name}:`, error && error.message ? error.message : error);
    return fallback;
  }
};

const DCC_SEVA_MAPPINGS = parseJsonEnv("DCC_SEVA_MAPPINGS", []);
const DEFAULT_NAME_BASED_SEVA_MAPPINGS = [
  {
    sourcePage: ["donations", "janmashtami"],
    sevaNameIncludes: ["annadana", "anna daan", "anna-daan", "annadaan"],
    sevaCategory: 24,
    sevaSubCategory: 115,
    sevaSubCategoryCode: "MNSO-A",
  },
  {
    sourcePage: ["donations", "janmashtami"],
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    sevaCategory: 24,
    sevaSubCategory: 116,
    sevaSubCategoryCode: "MNSO-G",
  },
  {
    sourcePage: ["donations", "janmashtami"],
    sevaNameIncludes: ["square feet", "square foot", "sq ft"],
    sevaCategory: 24,
    sevaSubCategory: 117,
    sevaSubCategoryCode: "MNSO-S",
  },
];

const formatDateForDcc = (value) => {
  const date = value ? new Date(value) : new Date();
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
};

const compact = (parts) => parts.map((part) => String(part || "").trim()).filter(Boolean);

const normalizeString = (value) => String(value || "").trim().toLowerCase();

const toNumberArray = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  }
  const single = Number(value);
  return Number.isFinite(single) ? [single] : [];
};

const buildFullAddress = (prasadamAddress) => {
  if (!prasadamAddress) return null;
  const value = compact([
    prasadamAddress.doorNo,
    prasadamAddress.house,
    prasadamAddress.street,
    prasadamAddress.area,
    prasadamAddress.city,
    prasadamAddress.state,
    prasadamAddress.pincode,
    prasadamAddress.country,
  ]).join(", ");
  return value || null;
};

const isSpecialEnrolledByDonation = (donation) => (
  normalizeString(donation.sourcePage) === "donations" ||
  normalizeString(donation.sourcePage) === "janmashtami" ||
  normalizeString(donation.festivalSlug) === "janmashtami"
);

const resolveEnrolledBy = (donation) => {
  if (isSpecialEnrolledByDonation(donation)) {
    return Number(
      process.env.DCC_ENROLLED_BY_DONATIONS_AND_JANMASHTAMI ||
      process.env.DCC_ENROLLED_BY_SPECIAL ||
      process.env.DCC_ENROLLED_BY ||
      25
    );
  }

  return Number(
    process.env.DCC_ENROLLED_BY_REST ||
    process.env.DCC_ENROLLED_BY_DEFAULT ||
    process.env.DCC_ENROLLED_BY ||
      36
  );
};

const mappingMatchesDonation = (mapping, donation) => {
  if (!mapping || typeof mapping !== "object") return false;

  if (mapping.legacySevaId != null || mapping.legacySevaIds != null) {
    const allowedLegacyIds = [
      ...toNumberArray(mapping.legacySevaId),
      ...toNumberArray(mapping.legacySevaIds),
    ];
    if (!allowedLegacyIds.includes(Number(donation.legacySevaId))) return false;
  }

  if (mapping.sourcePage) {
    const allowed = Array.isArray(mapping.sourcePage) ? mapping.sourcePage : [mapping.sourcePage];
    if (!allowed.map(normalizeString).includes(normalizeString(donation.sourcePage))) return false;
  }

  if (mapping.festivalSlug) {
    const allowed = Array.isArray(mapping.festivalSlug) ? mapping.festivalSlug : [mapping.festivalSlug];
    if (!allowed.map(normalizeString).includes(normalizeString(donation.festivalSlug))) return false;
  }

  if (mapping.paymentAccount) {
    const allowed = Array.isArray(mapping.paymentAccount) ? mapping.paymentAccount : [mapping.paymentAccount];
    if (!allowed.map(normalizeString).includes(normalizeString(donation.paymentAccount))) return false;
  }

  if (mapping.type) {
    const allowed = Array.isArray(mapping.type) ? mapping.type : [mapping.type];
    if (!allowed.map(normalizeString).includes(normalizeString(donation.type))) return false;
  }

  if (mapping.sevaName) {
    const allowed = Array.isArray(mapping.sevaName) ? mapping.sevaName : [mapping.sevaName];
    if (!allowed.map(normalizeString).includes(normalizeString(donation.sevaName))) return false;
  }

  if (mapping.sevaNameIncludes) {
    const needles = Array.isArray(mapping.sevaNameIncludes) ? mapping.sevaNameIncludes : [mapping.sevaNameIncludes];
    const target = normalizeString(donation.sevaName);
    if (!needles.map(normalizeString).some((needle) => needle && target.includes(needle))) return false;
  }

  return true;
};

const resolveSevaMapping = (donation) => {
  const matched = DCC_SEVA_MAPPINGS.find((mapping) => mappingMatchesDonation(mapping, donation))
    || DEFAULT_NAME_BASED_SEVA_MAPPINGS.find((mapping) => mappingMatchesDonation(mapping, donation));
  if (!matched) return DEFAULT_SEVA_MAPPING;

  return {
    sevaCategory: Number(matched.sevaCategory ?? DEFAULT_SEVA_MAPPING.sevaCategory),
    sevaSubCategory: Number(matched.sevaSubCategory ?? DEFAULT_SEVA_MAPPING.sevaSubCategory),
    sevaSubCategoryCode: matched.sevaSubCategoryCode ?? DEFAULT_SEVA_MAPPING.sevaSubCategoryCode,
  };
};

const buildDccPayload = (donation, gatewayPaymentId) => {
  const sevaMapping = resolveSevaMapping(donation);

  return {
    donorName: donation.donorName,
    donorPhone: donation.donorMobile || "",
    donorEmail: donation.donorEmail || null,
    gender: null,
    address: {
      fullAddress: buildFullAddress(donation.prasadamAddress),
      state: donation.prasadamAddress?.state || null,
      city: donation.prasadamAddress?.city || null,
      pinCode: donation.prasadamAddress?.pincode || null,
    },
    PAN: donation.panNumber || null,
    amount: String(Number(donation.amount)),
    accountType: Number(process.env.DCC_ACCOUNT_TYPE || 4),
    sevaCategory: sevaMapping.sevaCategory,
    sevaSubCategory: sevaMapping.sevaSubCategory,
    sevaSubCategoryCode: sevaMapping.sevaSubCategoryCode,
    modeOfPayment: DCC_PAYMENT_MODES.online,
    gatewayPaymentId: gatewayPaymentId || donation.razorpayPaymentId || donation.transactionId || null,
    transactionDate: formatDateForDcc(donation.date || donation.createdAt || new Date()),
    enrolledBy: resolveEnrolledBy(donation),
  };
};

const isDccConfigured = () => Boolean(process.env.DCC_API_KEY);

async function postToDcc(payload) {
  const response = await fetch(DCC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DCC-Api-Key": process.env.DCC_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (error) {
    parsed = { raw };
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && parsed.Message
      ? parsed.Message
      : raw || `DCC request failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.response = parsed;
    throw err;
  }

  return parsed;
}

async function syncDonationToDcc(donationOrId, gatewayPaymentId) {
  const donation = typeof donationOrId === "object" && donationOrId !== null
    ? donationOrId
    : await donationModel.findById(donationOrId);

  if (!donation) return { ok: false, skipped: true, reason: "donation_not_found" };
  if (!isDccConfigured()) return { ok: false, skipped: true, reason: "dcc_not_configured" };
  if (donation.receiptNumber || donation.dccSyncStatus === "synced") {
    return { ok: true, skipped: true, reason: "already_synced" };
  }

  const lock = await donationModel.findOneAndUpdate(
    {
      _id: donation._id,
      receiptNumber: { $in: [null, ""] },
      dccSyncStatus: { $ne: "syncing" },
    },
    {
      dccSyncStatus: "syncing",
      dccLastAttemptAt: new Date(),
    },
    { new: true }
  );

  if (!lock) {
    const latest = await donationModel.findById(donation._id);
    if (latest?.receiptNumber || latest?.dccSyncStatus === "synced") {
      return { ok: true, skipped: true, reason: "already_synced" };
    }
    return { ok: false, skipped: true, reason: "sync_in_progress" };
  }

  const payload = buildDccPayload(lock, gatewayPaymentId);

  try {
    const dccResponse = await postToDcc(payload);
    const receiptNumber = dccResponse?.ReceiptNumber || null;

    await donationModel.findByIdAndUpdate(lock._id, {
      dccSyncStatus: "synced",
      dccSyncedAt: new Date(),
      dccSyncError: null,
      dccPayload: payload,
      dccResponse,
      ...(receiptNumber
        ? {
            receiptNumber,
            receiptGeneratedAt: new Date(),
          }
        : {}),
    });

    return { ok: true, dccResponse, receiptNumber };
  } catch (error) {
    await donationModel.findByIdAndUpdate(lock._id, {
      dccSyncStatus: "failed",
      dccSyncError: error && error.message ? error.message : String(error),
      dccPayload: payload,
      dccResponse: error && error.response ? error.response : null,
    });

    console.error("DCC sync failed", lock._id.toString(), error && error.stack ? error.stack : error);
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  DCC_PAYMENT_MODES,
  buildDccPayload,
  isDccConfigured,
  resolveEnrolledBy,
  resolveSevaMapping,
  syncDonationToDcc,
};
