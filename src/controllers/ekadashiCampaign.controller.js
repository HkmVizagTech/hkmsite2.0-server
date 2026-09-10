const { ekadashiCampaignModel } = require("../models/ekadashiCampaign.model");

/**
 * Default Ekadashi campaign content — pre-populated with the current Shayani
 * Ekadashi data so the /ekadashi page always renders valid content even before
 * an admin has opened the editor.
 */

const DEFAULT_CAMPAIGN = {
  campaignName: "Shayani Ekadashi",
  pageTitle: "Shayani Ekadashi Seva",
  metaTitle: "Shayani Ekadashi Seva | Hare Krishna Vaikuntham Temple, Visakhapatnam",
  metaDesc:
    "Donate on Shayani Ekadashi (Ashadhi Ekadashi) as Lord Vishnu begins His four months of divine rest. Sponsor seva at the Hare Krishna Vaikuntham Temple on one of the year's most sacred days.",
  ogTitle: "Shayani Ekadashi Seva — Hare Krishna Vaikuntham Temple",
  ogDesc:
    "Offer seva on Shayani Ekadashi at the Hare Krishna Vaikuntham Temple. Your donation sustains daily worship, sacred bhog, and festive arrangements during Chaturmas.",
  ogImage:
    "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/ekadashi-posters/ad%20poster%201%2016-9%20%20final%20.jpg.webp",
  heroImage:
    "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/ekadashi-posters/ad%20poster%201%2016-9%20%20final%20.jpg.webp",
  heroImageMobile:
    "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/ekadashi-posters/poster%202%20final%20.jpg.webp",
  heroTagline: "A seva initiative of Hare Krishna Movement Visakhapatnam",
  heroHeading1: "Shayani Ekadashi",
  heroHeading2: "Seva",
  heroDesc:
    "Donate on Shayani Ekadashi (Ashadhi Ekadashi) as Lord Vishnu begins His four months of divine rest, and offer seva at the Hare Krishna Vaikuntham Temple on one of the year's most sacred days.",
  formHeading: "Donate for Ekadashi Seva",
  formSubheading:
    "Your donation on this sacred day supports special puja arrangements, sacred bhog, and temple seva performed at the Hare Krishna Vaikuntham Temple.",
  phone: "+91 89777 61187",
  phoneHref: "tel:+918977761187",
  email: "social@hkmvizag.org",
  orderType: "EKADASHI",

  sevas: [
    {
      key: "annadan",
      label: "Annadan Seva",
      icon: "🍛",
      sevaName: "Anna Daan Seva",
      category: "ANNADAAN",
      tiers: [
        { amount: 501 },
        { amount: 1251, default: true },
        { amount: 2501, popular: true },
        { amount: 3751 },
      ],
      unit: { price: 25, singular: "meal", plural: "meals" },
    },
    {
      key: "gau",
      label: "Gau Seva",
      icon: "🐄",
      sevaName: "Gau Seva",
      category: "GO SEVA",
      tiers: [
        { label: "10 cows, 1 day", amount: 1500 },
        { label: "Medicines", amount: 2500 },
        { label: "1 cow, 1 month", amount: 3500 },
        { label: "Green grass, 1 day", amount: 9000 },
      ],
    },
    {
      key: "deity",
      label: "Deity Seva",
      icon: "🌸",
      sevaName: "Vastra & Alankara Seva",
      category: "GDGD",
      tiers: [
        { label: "Daily vastra", amount: 501 },
        { label: "Festival vastra", amount: 2100 },
        { label: "Alankara set", amount: 5100 },
        { label: "Full month", amount: 11000 },
      ],
    },
    {
      key: "sadhu-bhojan",
      label: "Sadhu Bhojan Seva",
      icon: "🍽️",
      sevaName: "Sadhu Bhojan Seva",
      category: "ANNADAAN",
      tiers: [
        { amount: 500 },
        { amount: 1000, default: true },
        { amount: 2000 },
        { amount: 2500 },
        { amount: 5000 },
        { amount: 10000 },
      ],
      unit: { price: 100, singular: "plate", plural: "plates" },
    },
    {
      key: "vidya",
      label: "Vidya Daan",
      icon: "📚",
      sevaName: "Gita Daan Seva",
      category: "BD",
      tiers: [
        { amount: 250 },
        { amount: 1250 },
        { amount: 2500 },
        { amount: 12500 },
      ],
      unit: { price: 250, singular: "Gita", plural: "Gitas" },
    },
    {
      key: "general",
      label: "General Seva",
      icon: "🛕",
      sevaName: "General Seva",
      category: "GENERAL",
      tiers: [],
    },
  ],

  sevaCards: [
    {
      title: "Anna Daan Seva",
      description:
        "Feed devotees and the underprivileged with sanctified prasadam on Ekadashi — the highest form of charity.",
      image:
        "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1783677363792-1783677363601-462395264797134589073566144398536696847591n.jpg",
      href: "/anna-daan-seva",
      icon: "utensils",
    },
    {
      title: "Gau Seva",
      description:
        "Serve the sacred cows with fodder, care, and shelter — an act Lord Krishna Himself cherishes.",
      image:
        "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1783676646237-1783676645536-ChatGPTImageJul102026031357PM.png",
      href: "/gau-seva",
      icon: "heart",
    },
    {
      title: "Vastra & Alankara Seva",
      description:
        "Offer beautiful garments and ornaments to Sri Sri Radha Madan Mohan for the festival.",
      image:
        "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1783677419371-1783677418690-DietyPhotos.jpeg",
      href: "/alankara-vastra-seva",
      icon: "star",
    },
    {
      title: "Temple Construction",
      description:
        "Contribute to the ongoing construction of the Hare Krishna Vaikuntham Temple — an eternal offering.",
      image:
        "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1783677157979-1783677157883-Screenshot2026-07-10152227.png",
      href: "/sqft-seva-campaign",
      icon: "book",
    },
  ],

  significancePoints: [
    {
      title: "Divine Rest Begins",
      text: "Lord Vishnu enters His four-month period of Yog Nidra (divine sleep) on Shayani Ekadashi. Donations made on this day are believed to reach the Lord directly during this sacred time.",
    },
    {
      title: "Purification of Sins",
      text: "Scriptures state that charity performed on Shayani Ekadashi purifies past karmas and brings prosperity to the giver's household throughout Chaturmas.",
    },
    {
      title: "Auspicious Beginnings",
      text: "Any auspicious ceremony or seva performed on this day carries manifold merit. The spiritual vibrations of the temple are especially elevated during this period.",
    },
    {
      title: "Special Grace Throughout Chaturmas",
      text: "Devotees who serve with sincerity during Shayani Ekadashi are believed to receive Lord Vishnu's special grace throughout the four months of Chaturmas.",
    },
  ],

  whyDonateSections: [
    {
      title: "A Sacred Opportunity to Serve",
      text: "As Lord Vishnu enters His divine rest, devotees are given a rare window to earn deep spiritual merit through seva. Your contribution on this day helps sustain the daily worship, festive arrangements, and upkeep of the Hare Krishna Vaikuntham Temple, allowing you to take part in the Lord's service even from a distance.",
    },
    {
      title: "Seva That Reaches the Lord Directly",
      text: "Every rupee offered on Shayani Ekadashi goes toward special puja arrangements, sacred bhog preparation, decoration of the Deities, and the temple's daily rituals. Donating on this day is considered a direct offering placed at the Lord's lotus feet, carrying significance beyond an ordinary act of charity.",
    },
    {
      title: "Blessings for You and Your Family",
      text: "Scriptures state that charity performed on Ekadashi, especially Shayani Ekadashi, purifies past karmas and brings prosperity to the giver's household. As the Lord begins His four months of Yog Nidra, devotees who serve with sincerity during this period are believed to receive His special grace throughout Chaturmas.",
    },
    {
      title: "Be Part of the Temple's Ongoing Worship",
      text: "The Hare Krishna Vaikuntham Temple continues its daily seva through the support of devotees like you. Your Shayani Ekadashi donation ensures that the worship, bhog, and celebrations at the temple continue uninterrupted, connecting you to the temple's spiritual mission even if you cannot visit in person.",
    },
  ],

  faqs: [
    {
      q: "What is Shayani Ekadashi?",
      a: "Shayani Ekadashi (also known as Ashadhi Ekadashi) is one of the most sacred Ekadashi days in the Hindu calendar. It marks the day Lord Vishnu enters His four-month period of divine sleep (Yog Nidra) on the cosmic ocean. Donations and seva performed on this day are considered extremely auspicious.",
    },
    {
      q: "Why should I donate on Shayani Ekadashi?",
      a: "Donating on Shayani Ekadashi is believed to purify past karmas and bring prosperity. As the Lord begins His divine rest, your seva sustains the temple's worship and carries special spiritual merit throughout the four months of Chaturmas.",
    },
    {
      q: "How will my donation be used?",
      a: "Your donation supports special puja arrangements, sacred bhog preparation, decoration of the Deities, and the temple's daily rituals during the Ekadashi celebrations. For specific sevas like Anna Daan or Gau Seva, your contribution directly funds those activities.",
    },
    {
      q: "Is my donation eligible for 80G tax exemption?",
      a: "Yes. Donations to Hare Krishna Movement qualify for tax exemption under Section 80G of the Income Tax Act. Select the '80G receipt' option during checkout and provide your PAN.",
    },
    {
      q: "Will I receive a receipt?",
      a: "Yes. An email receipt is sent automatically the moment your payment is confirmed. Your 80G certificate follows separately once your PAN is verified.",
    },
    {
      q: "Is it safe to donate online here?",
      a: "Yes. All payments are processed through Razorpay, a PCI-DSS-compliant payment gateway. We never see or store your card details. You may also donate via direct bank transfer using the details on this page.",
    },
  ],

  shloka: {
    sanskrit: "एकादश्या यतः पुण्यं ततः कोटिगुणं भवेत् । अश्वमेधशतं चैव विष्णोर्नामस्मरणं तथा ॥",
    translation:
      "The merit gained from observing Ekadashi is multiplied by a crore. Even greater is the merit of chanting the holy names of Lord Vishnu.",
    reference: "Padma Purana",
  },

  bankDetails: {
    beneficiaryName: "HARE KRISHNA MOVEMENT INDIA",
    bankName: "IDFC FIRST BANK LTD",
    accountNumber: "10091415313",
    ifsc: "IDFB0080412",
  },
};

/** Shallow + deep merge for nested objects and arrays. */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function mergeWithDefaults(content) {
  return deepMerge(DEFAULT_CAMPAIGN, content || {});
}

const ekadashiCampaignController = {
  /** Public: returns merged config. Creates a default record if none exists. */
  get: async (req, res) => {
    try {
      let record = await ekadashiCampaignModel.findOne({ key: "ekadashi" }).lean();
      if (!record) {
        record = await ekadashiCampaignModel.create({ key: "ekadashi", content: DEFAULT_CAMPAIGN });
        record = record.toObject();
      }
      return res.json(mergeWithDefaults(record.content));
    } catch (err) {
      console.error("ekadashiCampaignController.get error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  /** Admin: returns raw record (or default blob). */
  getConfig: async (req, res) => {
    try {
      let record = await ekadashiCampaignModel.findOne({ key: "ekadashi" }).lean();
      return res.json(mergeWithDefaults(record && record.content));
    } catch (err) {
      console.error("ekadashiCampaignController.getConfig error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  },

  /** Admin: upsert the campaign config. */
  update: async (req, res) => {
    try {
      const content = req.body && typeof req.body === "object" ? req.body : {};
      const payload = { content };
      if (req.user && req.user.userId) payload.updatedBy = req.user.userId;

      const record = await ekadashiCampaignModel.findOneAndUpdate(
        { key: "ekadashi" },
        payload,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();

      return res.json({ message: "Ekadashi campaign updated", config: mergeWithDefaults(record.content) });
    } catch (err) {
      console.error("ekadashiCampaignController.update error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { ekadashiCampaignController, DEFAULT_CAMPAIGN };
