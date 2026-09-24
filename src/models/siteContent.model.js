const mongoose = require("mongoose");

// Singleton document — one row holds all admin-editable site copy.
// Public GET is unauthenticated so the frontend can render it directly.
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, default: "main", unique: true },
    hero: {
      title: { type: String, default: "Hare Krishna Movement" },
      subtitle: { type: String, default: "Visakhapatnam" },
      tagline: {
        type: String,
        default: "Spreading the timeless message of Lord Krishna through devotion, service, and community",
      },
    },
    about: {
      heading: { type: String, default: "" },
      body: { type: String, default: "" },
    },
    contact: {
      phone: { type: String, default: "+91 96666 11108" },
      email: { type: String, default: "info.vizag@hkm-group.org" },
      address: { type: String, default: "Chaitanya Bhavan, Hare Krishna Vaikuntam Cultural Centre, IIM Rd, opp. Akshaya Patra Foundation, Gambhiram, Visakhapatnam, Andhra Pradesh 531163" },
      morningHours: { type: String, default: "4:30 AM - 1:00 PM" },
      eveningHours: { type: String, default: "4:00 PM - 8:30 PM" },
    },
    navbar: {
      // "none" = hide the highlight (default); "auto" = pick the current
      // major festival from the Vaishnava calendar; any registered festival
      // key forces it. Kept in sync with the client default in Navbar.tsx /
      // lib/majorFestival.ts — auto-highlighting previously left stale
      // festivals (e.g. Radhashtami for weeks around its date) in the nav.
      majorFestival: { type: String, default: "none" },
    },
    festival: {
      // Hero banners for the /festival index page. The festival title is
      // baked into the artwork, so the page renders the image standalone.
      // Editable under Admin → Content → Festivals; matched on the client by
      // lib/festivalShowcase.ts FESTIVAL_PAGE_BANNER.
      bannerDesktop: {
        type: String,
        default:
          "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1790229048498-1790229047458-festivaldesk.webp",
      },
      bannerMobile: {
        type: String,
        default:
          "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1790229047831-1790229047198-Festivalmob.webp",
      },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

const siteContentModel = mongoose.model("siteContent", siteContentSchema);

module.exports = { siteContentModel };
