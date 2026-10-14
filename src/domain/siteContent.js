export const DEFAULT_CONSTRUCTION_VIDEO_ID = "mPAt0gb__Hw";

export const siteContentDefaults = () => ({
  hero: {
    title: "Hare Krishna Movement",
    subtitle: "Visakhapatnam",
    tagline: "Spreading the timeless message of Lord Krishna through devotion, service, and community",
  },
  about: { heading: "", body: "" },
  contact: {
    phone: "+91 96666 11108",
    email: "info.vizag@hkm-group.org",
    address:
      "Chaitanya Bhavan, Hare Krishna Vaikuntam Cultural Centre, IIM Rd, opp. Akshaya Patra Foundation, Gambhiram, Visakhapatnam, Andhra Pradesh 531163",
    morningHours: "4:30 AM - 1:00 PM",
    eveningHours: "4:00 PM - 8:30 PM",
  },
  navbar: { majorFestival: "none", customLink: { enabled: false, label: "", href: "" } },
  festival: {
    bannerDesktop:
      "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1790229048498-1790229047458-festivaldesk.webp",
    bannerMobile:
      "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1790229047831-1790229047198-Festivalmob.webp",
  },
  construction: {
    videoUrl: "",
    videoId: DEFAULT_CONSTRUCTION_VIDEO_ID,
    photos: [
      { url: "/assets/construction-update-1.jpg", caption: "Foundation & Ground Floor" },
      { url: "/assets/construction-update-2.jpg", caption: "Structural Framework" },
      { url: "/assets/construction-update-3.jpg", caption: "Column & Beam Work" },
      { url: "/assets/construction-update-4.jpg", caption: "Multi-Level Construction" },
      { url: "/assets/construction-update-5.jpg", caption: "Building Elevation" },
    ],
  },
});
