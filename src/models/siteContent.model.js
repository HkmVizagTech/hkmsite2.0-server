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
      // A free-form nav link an admin can turn on separately from the major-
      // festival highlight above — a name + destination URL, shown the same
      // way in the nav (desktop link + mobile "More" sheet item). Both slots
      // are independent and can be shown at the same time.
      customLink: {
        enabled: { type: Boolean, default: false },
        label: { type: String, default: "" },
        href: { type: String, default: "" },
      },
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
    construction: {
      // The monthly temple-construction update video, shown on the Square Foot
      // and Brick Seva pages. Editable under Admin → Content → Construction so
      // swapping it each month is a paste-and-save, not a code change + deploy.
      //
      // Both fields are kept: `videoUrl` is exactly what the admin pasted, so
      // the form shows them their own link back; `videoId` is the 11-character
      // YouTube id parsed out of it, which is the only thing the embed needs.
      // Parsing happens once here on save rather than on every page render.
      videoUrl: { type: String, default: "" },
      // Defaults to the video that was hard-coded in ConstructionStatusSection,
      // so the page looks identical until someone changes it.
      videoId: { type: String, default: "mPAt0gb__Hw" },
      // "Recent Site Photos" — the strip under the video. Managed in the same
      // admin tab: upload an image, give it a caption, reorder or remove.
      // Order here is the order on the page.
      //
      // Defaults to the five photos that were hard-coded in
      // ConstructionStatusSection, so the gallery is unchanged until someone
      // edits it. A function default is required — a shared array literal
      // would be handed to every document by reference.
      photos: {
        type: [
          {
            _id: false,
            url: { type: String, required: true },
            caption: { type: String, default: "" },
          },
        ],
        default: () => [
          { url: "/assets/construction-update-1.jpg", caption: "Foundation & Ground Floor" },
          { url: "/assets/construction-update-2.jpg", caption: "Structural Framework" },
          { url: "/assets/construction-update-3.jpg", caption: "Column & Beam Work" },
          { url: "/assets/construction-update-4.jpg", caption: "Multi-Level Construction" },
          { url: "/assets/construction-update-5.jpg", caption: "Building Elevation" },
        ],
      },
      updatedAt: { type: Date },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

const siteContentModel = mongoose.model("siteContent", siteContentSchema);

module.exports = { siteContentModel };
