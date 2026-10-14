import { donors } from "../db/tables.js";
import { getNextSequence } from "../utils/counter.js";
import { IST } from "../config/timezone.js";

async function findOrCreateDonor({ mobile, name, email, raisedByPreacherId, createdVia = "donation" }) {
  const cleanMobile = String(mobile || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (!cleanMobile || cleanMobile.length !== 10) {
    throw new Error("A valid 10-digit mobile number is required to create a donor record.");
  }

  let donor = await donors.findOne({ mobile: cleanMobile });
  if (donor) {
    // Keep name/email reasonably fresh if the donor gave a fuller version
    // this time (e.g. first donation had no email, this one does).
    const updates = {};
    if (email && !donor.email) updates.email = email;
    if (name && name.trim() && name.trim() !== donor.name) updates.name = name.trim();
    if (Object.keys(updates).length) {
      donor = await donors.updateById(donor._id, updates);
    }
    return donor;
  }

  const seq = await getNextSequence("donorId");
  const year = new Date().toLocaleDateString("en-GB", { timeZone: IST, year: "numeric" });
  const donorId = `HKM-${year}-${String(seq).padStart(5, "0")}`;

  return donors.insert({
    donorId,
    mobile: cleanMobile,
    name: name?.trim() || (createdVia === "shop" ? "Devotee" : "Donor"),
    email: email?.trim() || undefined,
    createdVia,
    assignedPreacherId: raisedByPreacherId || undefined,
    firstRaisedByPreacherId: raisedByPreacherId || undefined,
  });
}

async function findOrCreateShopCustomer({ mobile, name, email }) {
  return findOrCreateDonor({ mobile, name, email, createdVia: "shop" });
}

export { findOrCreateDonor, findOrCreateShopCustomer };
