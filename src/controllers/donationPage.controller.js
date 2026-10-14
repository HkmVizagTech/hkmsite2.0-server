import { donationPages } from "../db/tables.js";
import { query } from "../db/pg.js";
import { donationPageSchema } from "../domain/schemas.js";

const defaultDonationPage = {
  key: "donations",
  heroEyebrow: "Hare Krishna Movement Vizag",
  heroTitle: "Donate Annadaan and Gau Seva Online",
  heroSubtitle: "Support Narasimha Jayanthi meals for hungry and needy people.",
  bannerImage: "/assets/donations-nsj-annadan-web.jpeg",
  bannerMobileImage: "/assets/donations-nsj-annadan-mobile.jpeg",
  trusteeBannerImage: "/assets/donations-trustee-banner.png",
  annadaanImage: "/assets/donations-annadana-real.jpg",
  goSevaImage: "/assets/donations-gau-seva-real.jpeg",
  annadaanTitle: "Annadaan Seva",
  annadaanDescription:
    "Choose the number of people you would like to feed. Each offering supports prasadam distribution and community service.",
  goSevaTitle: "Gau Seva",
  goSevaDescription: "Support daily care for cows through food, medicines, green grass and yearly adoption sevas.",
  donationOptions: [
    { id: 11, category: "ANNADAAN", title: "Feed 50 people", amount: 1501 },
    { id: 1, category: "ANNADAAN", title: "Feed 100 people", amount: 3001 },
    { id: 2, category: "ANNADAAN", title: "Feed 200 people", amount: 6001 },
    { id: 3, category: "ANNADAAN", title: "Feed 300 people", amount: 9001 },
    { id: 4, category: "ANNADAAN", title: "Feed 500 people", amount: 15001 },
    { id: 5, category: "ANNADAAN", title: "Feed 1000 people", amount: 30001 },
    { id: 6, category: "ANNADAAN", title: "Feed 2000 people", amount: 60001 },
    { id: 7, category: "ANNADAAN", title: "Feed 3000 people", amount: 90001 },
    { id: 8, category: "ANNADAAN", title: "Feed 5000 people", amount: 150000 },
    { id: 9, category: "ANNADAAN", title: "Feed 10,000 people", amount: 300000 },
    { id: 10, category: "ANNADAAN", title: "Donate any other Amount", amount: null },
    { id: 21, category: "GO SEVA", title: "Feed 10 Cows For A Day", amount: 1500 },
    { id: 12, category: "GO SEVA", title: "Medicines For Cow", amount: 2500 },
    { id: 13, category: "GO SEVA", title: "Feed A Cow For A Month", amount: 3500 },
    { id: 14, category: "GO SEVA", title: "Feed 5 Cows For A Week", amount: 5000 },
    { id: 15, category: "GO SEVA", title: "Green Grass For All Cows For A Day", amount: 9000 },
    { id: 16, category: "GO SEVA", title: "Fodder For All Cows For A Day", amount: 15000 },
    { id: 17, category: "GO SEVA", title: "Adopt A Cow For An Year", amount: 40000 },
    { id: 18, category: "GO SEVA", title: "Adopt 3 Cows For An Year", amount: 120000 },
    { id: 19, category: "GO SEVA", title: "Adopt 5 Cows For An Year", amount: 200000 },
    { id: 20, category: "GO SEVA", title: "Donate any other Amount", amount: null },
  ],
  galleryImages: [
    "/assets/donations-service-activity-1.png",
    "/assets/donations-service-activity-2.png",
    "/assets/donations-service-activity-3.png",
    "/assets/donations-service-activity-4.png",
  ],
  impactItems: [
    { title: "Daily prasadam", text: "Offer food with dignity, devotion and care." },
    { title: "Protected cow care", text: "Support fodder, grass and medical needs." },
    { title: "Secure checkout", text: "Razorpay payment with receipt-ready donor details." },
  ],
  bankDetails: {
    beneficiaryName: "HARE KRISHNA MOVEMENT INDIA",
    bankName: "IDFC FIRST BANK LTD",
    accountNumber: "10091415313",
    ifsc: "IDFB0080412",
  },
  contact: {
    phone: "89777 61187",
    email: "mukunda@hkmvizag.org",
    note: "Gentle Request! While doing Paytm/UPI App Payments or Bank (NEFT/RTGS), please send us a screenshot along with complete address and PAN details.",
  },
};

const mergeWithDefaults = (page) => ({
  ...defaultDonationPage,
  ...(page || {}),
  bankDetails: {
    ...defaultDonationPage.bankDetails,
    ...((page && page.bankDetails) || {}),
  },
  contact: {
    ...defaultDonationPage.contact,
    ...((page && page.contact) || {}),
  },
  impactItems:
    page && Array.isArray(page.impactItems) && page.impactItems.length
      ? page.impactItems
      : defaultDonationPage.impactItems,
  donationOptions:
    page && Array.isArray(page.donationOptions) && page.donationOptions.length
      ? page.donationOptions
      : defaultDonationPage.donationOptions,
  galleryImages:
    page && Array.isArray(page.galleryImages) && page.galleryImages.length
      ? page.galleryImages
      : defaultDonationPage.galleryImages,
});

// Mongo kept an explicit `field: null` apart from a missing field (it then overrides the default shown
// to visitors); the NULL column cannot, so the nulled fields are remembered in `extra`.
const NULLS = "$nulls";
const readPage = async () => {
  const page = await donationPages.findOne({ key: "donations" }, { lean: true });
  if (!page) return page;
  for (const k of page[NULLS] || []) page[k] = null;
  delete page[NULLS];
  return page;
};

const donationPageController = {
  get: async (req, res) => {
    try {
      return res.json({ page: mergeWithDefaults(await readPage()) });
    } catch (err) {
      console.error("donationPageController.get error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const allowed = [
        "heroTitle",
        "heroSubtitle",
        "heroEyebrow",
        "bannerImage",
        "bannerMobileImage",
        "trusteeBannerImage",
        "annadaanImage",
        "goSevaImage",
        "annadaanTitle",
        "annadaanDescription",
        "goSevaTitle",
        "goSevaDescription",
        "donationOptions",
        "galleryImages",
        "impactItems",
        "bankDetails",
        "contact",
      ];

      const payload = {};
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) payload[key] = req.body[key];
      }
      payload.key = "donations";
      if (req.user && req.user.userId) payload.updatedBy = req.user.userId;

      const cast = donationPageSchema.castUpdate(payload);
      const existing = await donationPages.findOne({ key: "donations" }, { lean: true });
      let id = existing?._id;
      if (existing) await donationPages.updateById(id, cast);
      else {
        const defaults = donationPageSchema.create({});
        id = (await donationPages.insert({ ...defaults, ...cast }))._id;
      }
      const before = existing?.[NULLS] || [];
      const nulls = [
        ...new Set([
          ...before.filter((k) => cast[k] === undefined),
          ...Object.keys(cast).filter((k) => cast[k] === null),
        ]),
      ];
      if (nulls.length || before.length) {
        await query(
          nulls.length
            ? `UPDATE donation_pages SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{${NULLS}}', $2::jsonb) WHERE id = $1`
            : `UPDATE donation_pages SET extra = NULLIF(extra - '${NULLS}', '{}'::jsonb) WHERE id = $1`,
          nulls.length ? [id, JSON.stringify(nulls)] : [id]
        );
      }

      return res.json({ message: "Donation page updated", page: mergeWithDefaults(await readPage()) });
    } catch (err) {
      console.error("donationPageController.update error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  },
};

export { donationPageController, defaultDonationPage };
