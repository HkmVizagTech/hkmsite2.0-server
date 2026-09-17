/**
 * Shared source of truth for the "current festival" donation campaigns
 * shown on the home page and /donations (served by /festival-donations/all).
 *
 * Consumed at server boot (ensureDefaultFestivalDonations) so production
 * always ships with the canonical campaigns (Radhashtami, Govardhan Puja,
 * Ekadashi), and by the standalone seed script
 * (scripts/seed-festival-donations.js) for on-demand runs. Always
 * idempotent:
 *
 *   - canonical slugs are upserted by slug (existing ones keep the admin's
 *     edits — only missing fields are filled in),
 *   - clearly-test junk records (titles like "Testing…", "fsdfsd…") are
 *     deactivated (active: false, never deleted) so they drop off the
 *     public section immediately but stay visible in the admin DB.
 *
 * Images below are the same campaign posters used by the existing
 * /radhashtami, /govardhan-puja and /ekadashi pages.
 */

const { festivalDonationModel } = require("../models/festivalDonation.model");

const CANONICAL_SLUGS = ["radhashtami", "govardhan-puja", "ekadashi"];

const DEFAULT_FESTIVAL_DONATIONS = [
  {
    slug: "radhashtami",
    title: "Sri Radhashtami Seva",
    description:
      "Celebrate the appearance day of Srimati Radharani with sacred seva at the Hare Krishna Vaikuntham Temple, Visakhapatnam. Offer puja, bhog and festive arrangements on this most auspicious day.",
    images: [
      "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1788946765218-1788946764659-Radhashtamidesk.webp",
    ],
    donationOptions: [
      { label: "Special Puja Seva", amount: 5555, description: "Sponsor special puja arrangements for Sri Radhashtami." },
      { label: "Bhog Seva", amount: 2100, description: "Offer sanctified bhog to the Lordships on Radhashtami." },
      { label: "General Donation", amount: 1100, description: "Support Radhashtami celebrations at the temple." },
    ],
    meta: {
      eventDate: "2026-09-19",
      sectionHeading: "Offer Your Seva",
      superTitle: "Srimati Radharani's",
    },
  },
  {
    slug: "govardhan-puja",
    title: "Sri Govardhan Puja Seva",
    description:
      "Offer sacred Govardhan Puja sevas — Govardhan, Gau, Bhog, Alankar, Annakoot and Vaishnav Bhojan Seva at the Hare Krishna Vaikuntham Temple, Visakhapatnam.",
    images: [
      "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1789476038584-1789476037499-govardhan-desk.webp",
    ],
    donationOptions: [
      { label: "Annakoot Seva", amount: 11111, description: "Sponsor the grand Annakut ('Rice Mountain') offering." },
      { label: "Gau Seva", amount: 5555, description: "Serve the sacred cows on the day of Govardhan Puja." },
      { label: "Bhog Seva", amount: 2100, description: "Offer bhog prasadam for the Govardhan Puja festival." },
    ],
    meta: {
      eventDate: "2026-11-10",
      sectionHeading: "Offer Your Seva",
      superTitle: "Sri Govardhan Puja",
    },
  },
  {
    slug: "ekadashi",
    title: "Ekadashi Seva",
    description:
      "Sponsor sacred puja, bhog and temple seva on Ekadashi — the most auspicious fasting day — and support the daily worship at the Hare Krishna Vaikuntham Temple.",
    images: [
      "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/ekadashi-posters/ad%20poster%201%2016-9%20%20final%20.jpg.webp",
    ],
    donationOptions: [
      { label: "Annadan Seva", amount: 1251, description: "Feed devotees with sanctified prasadam on Ekadashi." },
      { label: "Gau Seva", amount: 2500, description: "Care for the temple cows on Ekadashi." },
      { label: "Deity Seva", amount: 2100, description: "Support Deity worship, vastra and offerings on Ekadashi." },
    ],
    meta: {
      eventDate: "2026-09-22",
      sectionHeading: "Offer Your Seva",
      superTitle: "Ekadashi Seva",
    },
  },
];

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Records that clearly came from clicking around while building this
// feature ("Testing on the server", "Testing festival locally",
// "fsdfsddfdfsdf"…) — deactivate them so they stop appearing publicly.
const isJunk = (doc) => {
  const haystack = `${doc.title || ""} ${doc.slug || ""} ${doc.description || ""}`.toLowerCase();
  return /test/i.test(haystack) || /fsdfsd/i.test(haystack);
};

async function ensureDefaultFestivalDonations() {
  const created = [];
  const skipped = [];
  const deactivated = [];

  for (const d of DEFAULT_FESTIVAL_DONATIONS) {
    const slug = slugify(d.slug);
    const existing = await festivalDonationModel.findOne({ slug }).lean();
    if (existing) {
      skipped.push(slug);
      continue;
    }
    await festivalDonationModel.create({
      ...d,
      slug,
      active: true,
      createdBy: undefined,
    });
    created.push(slug);
  }

  // Deactivate (never delete) obvious test records so the public
  // festival-donation section stops showing junk — reversible in the DB.
  const junk = await festivalDonationModel.find({
    active: true,
    slug: { $nin: CANONICAL_SLUGS },
  });
  for (const doc of junk) {
    if (!isJunk(doc)) continue;
    await festivalDonationModel.updateOne({ _id: doc._id }, { $set: { active: false } });
    deactivated.push(doc.title || doc.slug);
  }

  if (created.length || deactivated.length) {
    console.log(
      `Festival-donation bootstrap: created [${created.join(", ") || "none"}], skipped [${skipped.join(", ") || "none"}], deactivated ${deactivated.length} test record(s) [${deactivated.join(", ") || "none"}].`
    );
  }
  return { created, skipped, deactivated };
}

module.exports = { DEFAULT_FESTIVAL_DONATIONS, CANONICAL_SLUGS, slugify, ensureDefaultFestivalDonations };