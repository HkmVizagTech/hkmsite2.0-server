const { templeDevoteeModel } = require("../models/templeDevotee.model");

// The /donations family belongs to a separate team and always keeps its own receipt ID.
const DONATIONS_FAMILY = /^\/?donations(\/|$)/i;

/**
 * Finds the active temple devotee a seva-page link points to. `ref` is what followed the page in the URL:
 * either the devotee's code ("ABRD", any case) or their DCC id ("1"). Anything else returns null, and the
 * donation keeps the default receipt ID.
 */
async function resolvePreacherRef(ref) {
  const r = String(ref == null ? "" : ref).trim();
  if (!r || r.length > 12 || !/^[A-Za-z0-9-]+$/.test(r)) return null;
  const query = /^\d+$/.test(r) ? { dccEnrolledById: Number(r) } : { code: r.toUpperCase(), dccEnrolledById: { $ne: null } };
  const d = await templeDevoteeModel.findOne({ ...query, status: "active" }).lean();
  return d || null;
}

/**
 * Receipt attribution for a new donation: { dccEnrolledById, preacherCode } or {}.
 * A campaigner link wins; otherwise a preacher ref from the page link. /donations pages are never credited.
 */
async function attributionFor({ sourcePage, campaignerSlug, preacherRef }) {
  if (campaignerSlug) {
    try {
      const { campaignerModel } = require("../models/campaigner.model");
      const camp = await campaignerModel.findOne({ slug: String(campaignerSlug), status: "active" }).populate("referredByDevotee", "dccEnrolledById code").lean();
      const id = camp?.referredByDevotee?.dccEnrolledById;
      if (Number.isFinite(Number(id)) && id != null) return { dccEnrolledById: Number(id), preacherCode: camp.referredByDevotee.code || undefined };
    } catch (e) {
      console.warn("campaigner devotee lookup failed:", e.message);
    }
  }
  if (!preacherRef || DONATIONS_FAMILY.test(String(sourcePage || ""))) return {};
  try {
    const d = await resolvePreacherRef(preacherRef);
    if (d) return { dccEnrolledById: Number(d.dccEnrolledById), preacherCode: d.code || undefined };
  } catch (e) {
    console.warn("preacher ref lookup failed:", e.message);
  }
  return {};
}

module.exports = { resolvePreacherRef, attributionFor, DONATIONS_FAMILY };
