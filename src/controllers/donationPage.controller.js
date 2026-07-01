const { donationPageModel } = require("../models/donationPage.model");

const defaultDonationPage = {
  key: "donations",
  heroEyebrow: "Annadaan Seva and Go Seva",
  heroTitle: "Serve prasadam. Protect cows. Offer with devotion.",
  heroSubtitle: "Continue the trusted Hare Krishna Vizag donation flow with a clearer seva experience for devotees.",
  bannerImage: "/assets/donations-annadana-real.jpg",
  annadaanImage: "/assets/donations-annadana-real.jpg",
  goSevaImage: "/assets/donations-gau-seva-real.jpeg",
  annadaanTitle: "Annadaan Seva",
  annadaanDescription: "Choose the number of people you would like to feed. Each offering supports prasadam distribution and community service.",
  goSevaTitle: "Go Seva",
  goSevaDescription: "Support daily care for cows through food, medicines, green grass and yearly adoption sevas.",
  donationOptions: [
    { id: 101, category: "ANNADAAN", title: "Offer Annadaan Seva", amount: 251 },
    { id: 102, category: "ANNADAAN", title: "Support Annadaan Seva", amount: 500 },
    { id: 103, category: "ANNADAAN", title: "Sponsor Annadaan Seva", amount: 1000 },
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
    { id: 201, category: "GO SEVA", title: "Offer Gau Seva", amount: 251 },
    { id: 202, category: "GO SEVA", title: "Support Gau Seva", amount: 500 },
    { id: 203, category: "GO SEVA", title: "Sponsor Gau Seva", amount: 1000 },
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
    phone: "9063 020 108",
    email: "social@hkmvizag.org",
    note: "While doing Paytm, UPI app payments or bank NEFT/RTGS, please send us a screenshot with complete address and PAN details.",
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
  impactItems: page && Array.isArray(page.impactItems) && page.impactItems.length
    ? page.impactItems
    : defaultDonationPage.impactItems,
  donationOptions: page && Array.isArray(page.donationOptions) && page.donationOptions.length
    ? page.donationOptions
    : defaultDonationPage.donationOptions,
});

const donationPageController = {
  get: async (req, res) => {
    try {
      const page = await donationPageModel.findOne({ key: "donations" }).lean();
      return res.json({ page: mergeWithDefaults(page) });
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
        "annadaanImage",
        "goSevaImage",
        "annadaanTitle",
        "annadaanDescription",
        "goSevaTitle",
        "goSevaDescription",
        "donationOptions",
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

      const page = await donationPageModel.findOneAndUpdate(
        { key: "donations" },
        payload,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();

      return res.json({ message: "Donation page updated", page: mergeWithDefaults(page) });
    } catch (err) {
      console.error("donationPageController.update error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { donationPageController, defaultDonationPage };
