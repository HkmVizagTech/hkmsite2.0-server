import { donations, claimUpdate } from "../domain/donationDb.js";
import { donors } from "../db/tables.js";
import { tx } from "../db/pg.js";
import { IST } from "../config/timezone.js";
import { toEnglish } from "../utils/toEnglish.js";
import { notifyDrmOfDonation } from "./drmNotify.service.js";

const DCC_API_URL = process.env.DCC_API_URL || "https://vhkmsurabhi.com/api/socialmedia/addDonation";

const normalizeDccPhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

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
    sevaNameIncludes: ["annadana", "anna daan", "anna-daan", "annadaan"],
    festivalSlug: "radhashtami",
    sevaCategory: 3,
    sevaSubCategory: 12,
    sevaSubCategoryCode: 37,
  },
  {
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    festivalSlug: "radhashtami",
    sevaCategory: 3,
    sevaSubCategory: 12,
    sevaSubCategoryCode: 137,
  },
  {
    sevaNameIncludes: ["pushpalankara", "pushpa alankara", "pushpanjali"],
    festivalSlug: "radhashtami",
    sevaCategory: 3,
    sevaSubCategory: 12,
    sevaSubCategoryCode: 39,
  },
  {
    sevaNameIncludes: ["abhishekam", "abhisheka", "abhishek"],
    festivalSlug: "radhashtami",
    sevaCategory: 3,
    sevaSubCategory: 12,
    sevaSubCategoryCode: 50,
  },

  {
    sevaNameIncludes: ["annadana", "anna daan", "anna-daan", "annadaan"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 27,
  },
  {
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 102,
  },
  {
    sevaNameIncludes: ["makhan mishri", "makhan-mishri"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 93,
  },
  {
    sevaNameIncludes: ["abhisheka", "abhishek"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 31,
  },
  {
    sevaNameIncludes: ["tulasi archana", "tulasi-archana", "tulsi archana"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 72,
  },
  {
    sevaNameIncludes: ["pushpalankara", "pushpa alankara", "pushpanjali"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 29,
  },
  {
    sevaNameIncludes: ["naivedhya", "naivedya"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 74,
  },
  {
    sevaNameIncludes: ["vastrabharana", "vastra abharana", "vastra-abharana"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 75,
  },
  {
    sevaNameIncludes: ["mandapa", "mandap"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 28,
  },
  {
    // Chappan Bhog → uses Naivedya code (no separate DCC entry)
    sevaNameIncludes: ["chappan bhog", "chappan-bhog", "56 bhog"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 74,
  },
  {
    // Japa Yagna → uses Annadana code (no separate DCC entry)
    sevaNameIncludes: ["japa yagna", "japa-yagna", "japa yagya"],
    festivalSlug: "janmashtami",
    sevaCategory: 3,
    sevaSubCategory: 10,
    sevaSubCategoryCode: 27,
  },
  {
    sevaNameIncludes: ["govardhan seva"],
    festivalSlug: "govardhan-puja",
    sevaCategory: 3,
    sevaSubCategory: 6,
    sevaSubCategoryCode: 9,
  },
  {
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    festivalSlug: "govardhan-puja",
    sevaCategory: 3,
    sevaSubCategory: 6,
    sevaSubCategoryCode: 131,
  },
  {
    sevaNameIncludes: ["bhog seva", "rajbhog"],
    festivalSlug: "govardhan-puja",
    sevaCategory: 3,
    sevaSubCategory: 6,
    sevaSubCategoryCode: 79,
  },
  {
    sevaNameIncludes: ["alankar seva", "pushpalankara", "alankara seva"],
    festivalSlug: "govardhan-puja",
    sevaCategory: 3,
    sevaSubCategory: 6,
    sevaSubCategoryCode: 8,
  },
  {
    sevaNameIncludes: ["annakoot", "annakuta", "annakoota"],
    festivalSlug: "govardhan-puja",
    sevaCategory: 3,
    sevaSubCategory: 6,
    sevaSubCategoryCode: 11,
  },
  {
    sevaNameIncludes: ["vaishnav bhojan", "vaishnava bhojan", "sadhu bhojan"],
    festivalSlug: "govardhan-puja",
    sevaCategory: 3,
    sevaSubCategory: 6,
    // Feeding devotees → Annadana Seva (no separate Vaishnav Bhojan entry)
    sevaSubCategoryCode: 6,
  },
  {
    festivalSlug: "pitru-paksha",
    type: ["ANNADAAN"],
    sevaCategory: 1,
    sevaSubCategory: 1,
    sevaSubCategoryCode: "ANGE",
  },
  {
    festivalSlug: "pitru-paksha",
    type: ["VAISHNAV BHOJAN"],
    sevaCategory: 1,
    sevaSubCategory: 1,
    // TODO: real "Vaishnav Bhojan" seva code once provided — Sadhu Bhojan
    // intentionally reuses the Annadana code (ANGE) for now.
    sevaSubCategoryCode: "ANGE",
  },
  {
    festivalSlug: "pitru-paksha",
    type: ["GO SEVA"],
    sevaCategory: 20,
    sevaSubCategory: 76,
    sevaSubCategoryCode: "GOSE",
  },
  {
    festivalSlug: "pitru-paksha",
    type: ["SQFT"],
    sevaCategory: 24,
    sevaSubCategory: 117,
    sevaSubCategoryCode: "MNSO-S",
  },
  {
    festivalSlug: "pitru-paksha",
    type: ["BRICK"],
    sevaCategory: 24,
    sevaSubCategory: 118,
    sevaSubCategoryCode: "MNSO-B",
  },
  {
    sevaNameIncludes: ["yajamana"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 104,
  },
  {
    sevaNameIncludes: ["pushpalankara", "pushpa alankara", "pushpanjali"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 105,
  },
  {
    // DCC spells this one "Mantapa Seva" (not Mandapa).
    sevaNameIncludes: ["mantapa", "mandapa", "mandap"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 106,
  },
  {
    sevaNameIncludes: ["vastrabharana", "vastra abharana", "vastra-abharana"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 107,
  },
  {
    sevaNameIncludes: ["annadana", "anna daan", "anna-daan", "annadaan"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 108,
  },
  {
    sevaNameIncludes: ["homam", "homa seva", "yagna", "yajna"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 109,
  },
  {
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    festivalSlug: "vijayadashami",
    sevaCategory: 3,
    sevaSubCategory: 106,
    sevaSubCategoryCode: 141,
  },
  // ---- Generic seva mappings (non-festival) ----
  {
    sevaNameIncludes: ["annadana", "anna daan", "anna-daan", "annadaan", "sadhu bhojan", "sadhu vaishnav bhojan"],
    sevaCategory: 1,
    sevaSubCategory: 1,
    sevaSubCategoryCode: "ANGE",
  },
  {
    type: ["ANNADAAN"],
    sevaCategory: 1,
    sevaSubCategory: 1,
    sevaSubCategoryCode: "ANGE",
  },
  {
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    sevaCategory: 20,
    sevaSubCategory: 76,
    sevaSubCategoryCode: "GOSE",
  },
  // Same reasoning as ANNADAAN above -- /donations page sets type:"GO SEVA"
  // exactly, with tier text (e.g. "Feed 10 Cows For A Day") as sevaName.
  {
    type: ["GO SEVA"],
    sevaCategory: 20,
    sevaSubCategory: 76,
    sevaSubCategoryCode: "GOSE",
  },
  {
    sevaNameIncludes: ["square feet", "square foot", "sq ft", "mandir nirman"],
    sevaCategory: 24,
    sevaSubCategory: 117,
    sevaSubCategoryCode: "MNSO-S",
  },
  {
    sevaNameIncludes: ["brick"],
    sevaCategory: 24,
    sevaSubCategory: 118,
    sevaSubCategoryCode: "MNSO-B",
  },
  {
    sevaNameIncludes: ["gita daan", "gita dan", "bhagavad gita"],
    type: ["BD"],
    sevaCategory: 4,
    sevaSubCategory: 15,
    sevaSubCategoryCode: "BD",
  },
  {
    type: ["BD"],
    sevaCategory: 4,
    sevaSubCategory: 15,
    sevaSubCategoryCode: "BD",
  },
  {
    sevaNameIncludes: ["vastra", "alankara"],
    type: ["GDGD"],
    sevaCategory: 2,
    sevaSubCategory: 3,
    sevaSubCategoryCode: "GDGD",
  },
  {
    type: ["GDGD"],
    sevaCategory: 2,
    sevaSubCategory: 3,
    sevaSubCategoryCode: "GDGD",
  },
];

const formatDateForDcc = (value) => {
  const date = value ? new Date(value) : new Date();
  // en-GB gives DD/MM/YYYY with 2-digit day and month and a 4-digit year,
  // which is exactly the shape DCC parses.
  return date.toLocaleDateString("en-GB", {
    timeZone: IST,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const compact = (parts) => parts.map((part) => String(part || "").trim()).filter(Boolean);

const normalizeString = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const toNumberArray = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  const single = Number(value);
  return Number.isFinite(single) ? [single] : [];
};

const buildFullAddress = (prasadamAddress) => {
  if (!prasadamAddress) return null;
  const value = compact([
    toEnglish(prasadamAddress.doorNo),
    toEnglish(prasadamAddress.house),
    toEnglish(prasadamAddress.street),
    toEnglish(prasadamAddress.area),
    toEnglish(prasadamAddress.city),
    toEnglish(prasadamAddress.state),
    prasadamAddress.pincode,
    prasadamAddress.country,
  ]).join(", ");
  return value || null;
};

const DONATIONS_DOMAIN_PATTERN = /^donations(\/|$)/;
const isSpecialEnrolledByDonation = (donation) => DONATIONS_DOMAIN_PATTERN.test(normalizeString(donation.sourcePage));

const resolveEnrolledBy = (donation) => {
  if (donation && Number.isFinite(Number(donation.dccEnrolledById)) && donation.dccEnrolledById != null) {
    return Number(donation.dccEnrolledById);
  }

  if (isSpecialEnrolledByDonation(donation)) {
    return Number(
      process.env.DCC_ENROLLED_BY_DONATIONS_AND_JANMASHTAMI ||
        process.env.DCC_ENROLLED_BY_SPECIAL ||
        process.env.DCC_ENROLLED_BY ||
        25
    );
  }

  return Number(
    process.env.DCC_ENROLLED_BY_REST || process.env.DCC_ENROLLED_BY_DEFAULT || process.env.DCC_ENROLLED_BY || 36
  );
};

const mappingMatchesDonation = (mapping, donation) => {
  if (!mapping || typeof mapping !== "object") return false;

  if (mapping.legacySevaId != null || mapping.legacySevaIds != null) {
    const allowedLegacyIds = [...toNumberArray(mapping.legacySevaId), ...toNumberArray(mapping.legacySevaIds)];
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
  const matched =
    DCC_SEVA_MAPPINGS.find((mapping) => mappingMatchesDonation(mapping, donation)) ||
    DEFAULT_NAME_BASED_SEVA_MAPPINGS.find((mapping) => mappingMatchesDonation(mapping, donation));
  if (!matched) return DEFAULT_SEVA_MAPPING;

  return {
    sevaCategory: Number(matched.sevaCategory ?? DEFAULT_SEVA_MAPPING.sevaCategory),
    sevaSubCategory: Number(matched.sevaSubCategory ?? DEFAULT_SEVA_MAPPING.sevaSubCategory),
    sevaSubCategoryCode: matched.sevaSubCategoryCode ?? DEFAULT_SEVA_MAPPING.sevaSubCategoryCode,
  };
};

// The transaction id DCC stores and de-duplicates on.
const dccTransactionId = (donation, gatewayPaymentId) =>
  gatewayPaymentId || donation.utrNumber || donation.razorpayPaymentId || donation.transactionId || null;

/**
 * A seva chosen explicitly by the caller - DRM sends the three values for the seva
 * a person picked from its seva list. Returns the mapping DCC takes, or null when
 * anything is missing or malformed, in which case the caller falls back to
 * resolveSevaMapping and the receipt goes out exactly as it always has.
 *
 *   category / subCategory   whole numbers (Seva Category ID, Seva Sub Category ID)
 *   code                     a whole number (the sub code ID) or a short Seva Code text
 */
const cleanDccSeva = ({ category, subCategory, code } = {}) => {
  const asId = (v) => {
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const sevaCategory = asId(category);
  const sevaSubCategory = asId(subCategory);
  const rawCode = typeof code === "string" ? code.trim() : code;
  const codeId = asId(rawCode);
  const codeText = typeof rawCode === "string" && /^[A-Za-z0-9 ()&._-]{1,40}$/.test(rawCode) ? rawCode : null;
  const sevaSubCategoryCode = codeId ?? codeText;
  if (sevaCategory == null || sevaSubCategory == null || sevaSubCategoryCode == null) return null;
  return { sevaCategory, sevaSubCategory, sevaSubCategoryCode };
};

/** The explicit seva stored on a donation when it was raised, if there is one. */
const storedDccSeva = (donation) =>
  cleanDccSeva({
    category: donation?.dccSevaCategory,
    subCategory: donation?.dccSevaSubCategory,
    code: donation?.dccSevaSubCategoryCode,
  });

const buildDccPayload = (donation, gatewayPaymentId, sevaOverride = null) => {
  // The seva the caller picked, if one was sent (this attempt's, or the one kept on the
  // donation for a retry); otherwise the same name-based guess as ever.
  const sevaMapping = sevaOverride || storedDccSeva(donation) || resolveSevaMapping(donation);

  return {
    donorName: toEnglish(donation.donorName),
    donorPhone: normalizeDccPhone(donation.donorMobile),
    donorEmail: donation.donorEmail || null,
    gender: null,
    address: {
      fullAddress: buildFullAddress(donation.prasadamAddress),
      state: toEnglish(donation.prasadamAddress?.state) || null,
      city: toEnglish(donation.prasadamAddress?.city) || null,
      pinCode: donation.prasadamAddress?.pincode || null,
    },
    PAN: donation.panNumber || null,
    amount: String(Number(donation.amount)),
    accountType: Number(process.env.DCC_ACCOUNT_TYPE || 4),
    sevaCategory: sevaMapping.sevaCategory,
    sevaSubCategory: sevaMapping.sevaSubCategory,
    sevaSubCategoryCode: sevaMapping.sevaSubCategoryCode,
    modeOfPayment: donation.manualPaymentMode
      ? (DCC_PAYMENT_MODES[donation.manualPaymentMode] ?? DCC_PAYMENT_MODES.online)
      : DCC_PAYMENT_MODES.online,
    gatewayPaymentId: dccTransactionId(donation, gatewayPaymentId),
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

  if (parsed && typeof parsed === "object" && parsed.ReceiptNumber) return parsed;

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && parsed.Message
        ? parsed.Message
        : raw || `DCC request failed with status ${response.status}`;

    if (typeof message === "string" && message.toLowerCase().includes("transaction details exist")) {
      const err = new Error(
        "DCC already has this donation on record but did not return its receipt number. " +
          "Find the transaction in DCC (vhkmsurabhi.com) by donor name/amount/date and enter the receipt number here."
      );
      err.status = response.status;
      err.response = parsed;
      err.dccAlreadyExists = true;
      throw err;
    }

    const err = new Error(message);
    err.status = response.status;
    err.response = parsed;
    throw err;
  }

  return parsed;
}

async function syncDonationToDcc(donationOrId, gatewayPaymentId, opts = {}) {
  const donation =
    typeof donationOrId === "object" && donationOrId !== null ? donationOrId : await donations.findById(donationOrId);

  if (!donation) return { ok: false, skipped: true, reason: "donation_not_found" };
  if (!isDccConfigured()) return { ok: false, skipped: true, reason: "dcc_not_configured" };
  if (donation.receiptNumber) {
    return { ok: true, skipped: true, reason: "already_synced" };
  }
  if (donation.dccSyncStatus === "synced" && !dccTransactionId(donation, gatewayPaymentId)) {
    return { ok: true, skipped: true, reason: "already_synced" };
  }

  const lock = await claimUpdate(
    {
      _id: String(donation._id),
      receiptNumber: { $in: [null, ""] },
      dccSyncStatus: { $ne: "syncing" },
    },
    {
      dccSyncStatus: "syncing",
      dccLastAttemptAt: new Date(),
      $inc: { dccAttempts: 1 },
    }
  );

  if (!lock) {
    const latest = await donations.findById(donation._id);
    if (latest?.receiptNumber) {
      return { ok: true, skipped: true, reason: "already_synced" };
    }
    return { ok: false, skipped: true, reason: "sync_in_progress" };
  }

  const payload = buildDccPayload(lock, gatewayPaymentId, opts.seva || null);

  try {
    const dccResponse = await postToDcc(payload);
    const receiptNumber = dccResponse?.ReceiptNumber || null;
    const recovered = /already exists/i.test(String(dccResponse?.Message || ""));

    const dccDonorNumber = dccResponse?.DonorNumber || null;
    await tx(async (client) => {
      await donations.updateById(
        lock._id,
        {
          ...(recovered ? { dccRecoveredAt: new Date() } : {}),
          dccSyncStatus: "synced",
          dccSyncedAt: new Date(),
          dccSyncError: null,
          dccPayload: payload,
          dccResponse,
          ...(receiptNumber ? { receiptNumber, receiptGeneratedAt: new Date() } : {}),
        },
        { client }
      );
      if (dccDonorNumber && lock.donorRecordId) {
        await client.query("SAVEPOINT donor_number");
        try {
          await donors.updateById(lock.donorRecordId, { dccDonorNumber }, { client });
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT donor_number");
          console.error("Could not save dccDonorNumber to Donor record (non-fatal):", lock.donorRecordId, e.message);
        }
      }
    });

    if (lock.manualEntry && receiptNumber) {
      try {
        notifyDrmOfDonation(lock._id, { reason: "receipt_issued" }).catch(() => undefined);
      } catch {}
    }

    return { ok: true, dccResponse, receiptNumber };
  } catch (error) {
    await donations.updateById(lock._id, {
      dccSyncStatus: "failed",
      dccSyncError: error && error.message ? error.message : String(error),
      dccPayload: payload,
      dccResponse: error && error.response ? error.response : null,
    });

    console.error("DCC sync failed", lock._id.toString(), error && error.stack ? error.stack : error);
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

export {
  DCC_PAYMENT_MODES,
  buildDccPayload,
  cleanDccSeva,
  dccTransactionId,
  isDccConfigured,
  resolveEnrolledBy,
  resolveSevaMapping,
  syncDonationToDcc,
};
