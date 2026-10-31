const { donationModel } = require("../models/donation.model");
const { IST } = require("../config/timezone");
const { toEnglish } = require("../utils/toEnglish");

const DCC_API_URL = process.env.DCC_API_URL || "https://vhkmsurabhi.com/api/socialmedia/addDonation";

// DCC strictly requires a bare 10-digit Indian mobile number and rejects
// anything else with "Donor phone must be a valid 10-digit number." —
// confirmed live: donors entering a leading 0 (e.g. "09989482904", 11
// digits) or a +91/91 country code prefix were causing every one of their
// syncs to fail silently (donation still completes fine, just no DCC
// receipt or WhatsApp PDF for them). Strip those prefixes down to the
// last 10 digits before sending.
const normalizeDccPhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

// DCC's own ModeOfPayment table (DCC_DB lookup data): 1 Cash, 2 Card, 3 Online,
// 4 Cheque/DD, 5 Others. (The comment on SocialMediaPayload.modeOfPayment in the DCC
// source lists them in a different order; the table and the DCC screens are the truth.)
//
// A bank transfer is "Online": DCC's Online section asks for a Transaction Number and
// Transaction Date, which is the UTR and the day. Cheque is 4, NOT 2 - 2 is Card. These
// were cheque 2 and bank 4, which put a cheque in DCC as a Card and a bank transfer as
// Cheque/DD. Each can still be overridden by its DCC_MODE_* setting.
const DCC_PAYMENT_MODES = {
  online: Number(process.env.DCC_MODE_ONLINE || 3),
  cash: Number(process.env.DCC_MODE_CASH || 1),
  cheque: Number(process.env.DCC_MODE_CHEQUE || 4),
  upi: Number(process.env.DCC_MODE_UPI || 3),
  bank: Number(process.env.DCC_MODE_BANK || 3),
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
// NOTE: intentionally no `sourcePage` restriction on these — sevaNameIncludes
// alone is specific enough to identify the seva correctly, and a sourcePage
// allowlist silently breaks every time a new donation entry point is added
// (this bit us: /donate/[seva] and /sqft-seva-campaign donations were falling
// through to the generic Annadana default because their sourcePage wasn't in
// the original ["donations","janmashtami"] list).
//
// DCC subcategory codes for Brick/Gita Daan/Vastra/Mandir Nirman below are
// best-guess placeholders following the existing MNSO-* numbering pattern
// (118-120) — verify against the real DCC configuration and override via the
// DCC_SEVA_MAPPINGS env var if they differ, no code deploy needed to fix.
// Annadana and Gau Seva codes below are confirmed real DCC values. The
// others (Square Foot/Brick/Gita Daan/Vastra) are still best-guess
// placeholders following the old MNSO-* numbering pattern — verify against
// the real DCC configuration and override via DCC_SEVA_MAPPINGS if they
// differ, no code deploy needed to fix.
const DEFAULT_NAME_BASED_SEVA_MAPPINGS = [
  // ---- Kartik Maas (Damodar month) sevas: Cultural Program (3) -> Deepotsava (5, code DEEP) ----
  // Real DCC codes from the temple's SevaCodes sheet (SevaSubCategoryCodeId column). Scoped to festivalSlug
  // "kartik-maas" so no other page is affected. Vastrabharana is NOT mapped yet: it was not in the part of the
  // sheet we were given, so it still falls through to the default until the real code is supplied.
  {
    // Deep Daan for 1 Month + 108 Deep Daan -> "Deeparadhana Seva" (DEEP) row of the sheet
    sevaNameIncludes: ["deep daan", "deepa daan", "deepdaan"],
    festivalSlug: "kartik-maas",
    sevaCategory: 3,
    sevaSubCategory: 5,
    sevaSubCategoryCode: 90,
  },
  {
    // Vaishnav Bhojan -> Annadanam / "Brahamana Vaishnava Seva" (ANVS); the sheet has no SevaSubCategoryCodeId
    // for this row, so the text Seva Code is sent (same way ANGE/GOSE are for category 1).
    sevaNameIncludes: ["vaishnav bhojan", "vaishnava bhojan"],
    festivalSlug: "kartik-maas",
    sevaCategory: 1,
    sevaSubCategory: 85,
    sevaSubCategoryCode: "ANVS",
  },
  {
    sevaNameIncludes: ["annadana", "anna daan", "anna-daan", "annadaan"],
    festivalSlug: "kartik-maas",
    sevaCategory: 3,
    sevaSubCategory: 5,
    sevaSubCategoryCode: 1,
  },
  {
    sevaNameIncludes: ["gau seva", "go seva", "cow", "goshala"],
    festivalSlug: "kartik-maas",
    sevaCategory: 3,
    sevaSubCategory: 5,
    sevaSubCategoryCode: 130,
  },
  {
    sevaNameIncludes: ["pushpalankara", "pushpa alankara", "pushpanjali"],
    festivalSlug: "kartik-maas",
    sevaCategory: 3,
    sevaSubCategory: 5,
    sevaSubCategoryCode: 3,
  },

  // ---- Sri Radhashtami festival sevas (FIRST — must match before
  // Janmashtami/generic, since several seva names overlap) ----
  // Real DCC codes from the temple's SevaCodes sheet (uploaded 2026-09-13).
  // Cultural Program (3) → Sri Radhastami (12). Only the 4 sevas actually
  // live on /radhashtami are mapped — Mandapa Seva, Special Cake Offering
  // Seva, and Yajamana Seva have real DCC codes too (38, 103, 40) but
  // aren't offered as donation options on the page yet, so left out here
  // by explicit choice until they're added.
  //
  // NAIVEDYA GAP: /radhashtami's 5th seva ("Naivedya Seva") has NO DCC
  // code in the provided sheet at all - not mapped here. Until a real
  // code is provided, it falls through to the Janmashtami "naivedhya"
  // entry below (sevaSubCategoryCode 74) via that entry's own
  // festivalSlug scoping - WRONG for a Radhashtami donation, but at
  // least no longer silently cross-matching an unrelated festival's
  // code by accident like the others were.
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

  // ---- Janmashtami festival sevas (must match before generic) ----
  // Real DCC codes from SevaList2026.pdf. All SKJ sevas use
  // Cultural Program (3) → Sri Krishna Janmashtami (10).
  // EVERY entry below now has festivalSlug:"janmashtami" explicitly -
  // most of them (all but annadana/gau seva) were missing this scoping
  // until now, meaning they were silently matching ANY donation with a
  // similarly-named seva regardless of which festival it came from
  // (found while adding Radhashtami mappings above: Radhashtami's
  // Abhishekam/Pushpalankara sevas share enough of the same substring
  // text that they were very likely already getting Janmashtami's DCC
  // codes instead of a correct one - worth checking already-processed
  // Radhashtami donations against DCC for this).
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
  // ---- Govardhan Puja festival sevas ----
  // /govardhan-puja (component GovardhanPujaClient) sends
  // festivalSlug:"govardhan-puja" + sevaName = the seva title. Codes below are
  // the real DCC sub-category codes from SevaList2026 ("Govardhan Puja",
  // SevaCategoryId 3 / SevaSubCategoryId 6) — scoped so they apply only to
  // Govardhan Puja donations.
  // NOTE: "Govardhan Seva" (the main worship sponsor) has no literal DCC
  // entry — mapped to Yajamana Seva (9); swap if the temple prefers another.
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
  // ---- Pitru Paksha festival sevas ----
  // /pitru-paksha now sends the SAME `type` code as the standalone seva
  // pages, so these match the regular seva DCC codes (ANGE / GOSE / MNSO-S /
  // MNSO-B). Scoped to festivalSlug:"pitru-paksha" so no other page's
  // donation can cross-match these entries (both conditions must hold).
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
  // ---- Vijayadashami festival sevas ----
  // Real DCC codes from the temple's SevaList2026 sheet (provided
  // 2026-10-13): Cultural Program (3) -> Vijayadashami (106). The
  // /vijayadashami page sends festivalSlug "vijayadashami" plus sevaName =
  // the seva title, so BOTH conditions must hold and no other festival's
  // donation can cross-match these entries.
  //
  // The sevaNameIncludes needles below must stay in step with the seva
  // titles in app/vijayadashami/VijayadashamiClient.tsx - rename a seva
  // there without changing it here and the donation falls through to the
  // generic Annadana code.
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
  // The standalone /donations page sets type:"ANNADAAN" exactly but never a
  // matching sevaName (its sevaName is the specific tier text, e.g. "Feed
  // 50 people") -- without this, those donations silently fell through to
  // the generic DEFAULT_SEVA_MAPPING instead of the real Annadana code.
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

// DCC expects the transaction date as DD/MM/YYYY, and it is the date DCC
// files the donation under — which decides both its financial year and the
// receipt-number series it is issued from.
//
// This used to use getDate()/getMonth()/getFullYear(), which read the
// process's local zone. The process ran in UTC, so every donation taken
// between midnight and 05:30 IST was sent to DCC as the previous calendar
// day. On 1 April that put the donation in the previous financial year and
// gave it a receipt number from the wrong series — on a document the
// temple has to stand behind to the income-tax department.
//
// The zone is named here rather than left to follow process.env.TZ on
// purpose: this function produces a number on a legal document, and it must
// not change meaning because somebody later edits a deployment variable.
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

// DCC receipts are printed in English, so donor details typed in Telugu,
// Hindi or any other Indian script are converted to English letters before
// they are sent (రమేష్ కుమార్ → Ramesh Kumar). English text passes through
// unchanged; the donation itself keeps what the donor typed.
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

// Matches "donations" exactly or "donations/<anything>" — same pattern
// as EXCLUDE_DONATIONS_PAGE/DONATIONS_PAGE_FILTER elsewhere, so a future
// page added under /donations/... automatically gets the same enrolledBy
// treatment without needing this updated by hand each time.
const DONATIONS_DOMAIN_PATTERN = /^donations(\/|$)/;
const isSpecialEnrolledByDonation = (donation) => (
  DONATIONS_DOMAIN_PATTERN.test(normalizeString(donation.sourcePage))
);

const resolveEnrolledBy = (donation) => {
  // Campaigner-attributed donations carry a snapshot of the referring
  // temple devotee's DCC ID — that wins over all env-based defaults so
  // the receipt is raised under that devotee.
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

// The transaction id DCC stores and de-duplicates on.
const dccTransactionId = (donation, gatewayPaymentId) =>
  gatewayPaymentId || donation.utrNumber || donation.razorpayPaymentId || donation.transactionId || null;

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
    // 5 for a TSC seva (set by DRM with the seva), otherwise the usual 4.
    accountType: [4, 5].includes(Number(donation.dccAccountType))
      ? Number(donation.dccAccountType)
      : Number(process.env.DCC_ACCOUNT_TYPE || 4),
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

  // DCC answers a repeat push of a transaction it already has with the
  // receipt it issued the first time ("Transaction already exists —
  // returning existing donation and donor details."). A receipt number in
  // the reply is the answer we want, whatever the status code.
  if (parsed && typeof parsed === "object" && parsed.ReceiptNumber) return parsed;

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && parsed.Message
      ? parsed.Message
      : raw || `DCC request failed with status ${response.status}`;

    // DCC returns this when the transaction is already in their system
    // (from a prior sync attempt) but we don't have the receipt number.
    // It's not a true error — DCC has the donation — but we can't
    // auto-fetch the receipt from this endpoint. Surface a clear message
    // so admin knows to check DCC directly and enter the receipt manually.
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
  const donation = typeof donationOrId === "object" && donationOrId !== null
    ? donationOrId
    : await donationModel.findById(donationOrId);

  if (!donation) return { ok: false, skipped: true, reason: "donation_not_found" };
  if (!isDccConfigured()) return { ok: false, skipped: true, reason: "dcc_not_configured" };
  if (donation.receiptNumber) {
    return { ok: true, skipped: true, reason: "already_synced" };
  }
  // "synced" without a receipt number: DCC took it but the number never came
  // back. Pushing again is safe only when DCC can recognise the transaction
  // (it de-duplicates on the payment id / UTR and replies with the receipt it
  // already issued); without one, a second push would raise a second receipt.
  if (donation.dccSyncStatus === "synced" && !dccTransactionId(donation, gatewayPaymentId)) {
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
      $inc: { dccAttempts: 1 },
    },
    { new: true }
  );

  if (!lock) {
    const latest = await donationModel.findById(donation._id);
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

    await donationModel.findByIdAndUpdate(lock._id, {
      ...(recovered ? { dccRecoveredAt: new Date() } : {}),
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

    // DCC's own response is the AUTHORITATIVE donor identifier — DonorNumber
    // (e.g. "D49822") is DCC's real, official ID for this donor in their
    // CRM, completely separate from the sequential HKM-YYYY-NNNNN ID we
    // generate ourselves as a fallback before DCC has ever seen this donor.
    // Once we have DCC's real number, it should be preferred everywhere a
    // donor's ID is shown (dashboard, receipts, admin/preacher search).
    const dccDonorNumber = dccResponse?.DonorNumber || null;
    if (dccDonorNumber && lock.donorRecordId) {
      try {
        const { donorModel } = require("../models/donor.model");
        await donorModel.findByIdAndUpdate(lock.donorRecordId, { dccDonorNumber });
      } catch (e) {
        console.error("Could not save dccDonorNumber to Donor record (non-fatal):", lock.donorRecordId, e.message);
      }
    }

    // A hand-entered donation whose receipt number arrived on a retry, after
    // the entry itself: DRM is told now, or it keeps showing no receipt.
    // Online donations push from their own pipeline once this returns.
    if (lock.manualEntry && receiptNumber) {
      try {
        const { notifyDrmOfDonation } = require("./drmNotify.service");
        notifyDrmOfDonation(lock._id, { reason: "receipt_issued" }).catch(() => undefined);
      } catch {}
    }

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
  cleanDccSeva,
  dccTransactionId,
  isDccConfigured,
  resolveEnrolledBy,
  resolveSevaMapping,
  syncDonationToDcc,
};
