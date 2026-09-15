const { donorModel } = require("../models/donor.model");
const { getNextSequence } = require("../utils/counter");

// Finds the existing donor record for a mobile number, or creates one.
// Used whenever a donation happens (manual entry by a preacher, or later
// a donor's own donation via the login portal) so every donor accumulates
// one stable identity across however many times they give.
async function findOrCreateDonor({ mobile, name, email, raisedByPreacherId, createdVia = "donation" }) {
  const cleanMobile = String(mobile || "").replace(/\D/g, "").slice(-10);
  if (!cleanMobile || cleanMobile.length !== 10) {
    throw new Error("A valid 10-digit mobile number is required to create a donor record.");
  }

  let donor = await donorModel.findOne({ mobile: cleanMobile });
  if (donor) {
    // Keep name/email reasonably fresh if the donor gave a fuller version
    // this time (e.g. first donation had no email, this one does).
    const updates = {};
    if (email && !donor.email) updates.email = email;
    if (name && name.trim() && name.trim() !== donor.name) updates.name = name.trim();
    if (Object.keys(updates).length) {
      donor = await donorModel.findByIdAndUpdate(donor._id, updates, { new: true });
    }
    return donor;
  }

  const seq = await getNextSequence("donorId");
  const year = new Date().getFullYear();
  const donorId = `HKM-${year}-${String(seq).padStart(5, "0")}`;

  donor = await donorModel.create({
    donorId,
    mobile: cleanMobile,
    name: name?.trim() || (createdVia === "shop" ? "Devotee" : "Donor"),
    email: email?.trim() || undefined,
    createdVia,
    assignedPreacherId: raisedByPreacherId || undefined,
    firstRaisedByPreacherId: raisedByPreacherId || undefined,
  });
  return donor;
}

// Shop customers use the SAME identity record as donors — one person, one
// mobile number, one login, one saved address, whether they donate, buy a
// book, or both. The only difference is createdVia, so donor reports can
// still tell "has actually donated" from "bought something in the shop".
//
// Unlike the donor portal (which refuses unknown numbers outright), the shop
// must accept a first-time customer who has never given anything — otherwise
// nobody new could ever buy. The abuse risk that refusal was protecting
// against (a free way to fire WhatsApp messages at arbitrary numbers) is
// instead held down by the rate limits on the shop OTP route.
async function findOrCreateShopCustomer({ mobile, name, email }) {
  return findOrCreateDonor({ mobile, name, email, createdVia: "shop" });
}

module.exports = { findOrCreateDonor, findOrCreateShopCustomer };
