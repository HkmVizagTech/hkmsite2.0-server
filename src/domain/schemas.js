import { defineModel, ObjectId, Mixed, sub } from "./odm.js";
import { BLOG_CATEGORIES } from "./blog.js";
import { siteContentDefaults } from "./siteContent.js";

const sc = siteContentDefaults();

export const blogSchema = defineModel("blog", {
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  excerpt: { type: String, default: "" },
  content: { type: String, required: true },
  coverImage: { type: String, default: "" },
  images: [{ type: String }],
  category: { type: String, enum: BLOG_CATEGORIES, default: "Spiritual Knowledge" },
  tags: [{ type: String, trim: true }],
  author: {
    name: { type: String, default: "Admin" },
    avatar: { type: String, default: "" },
    bio: { type: String, default: "" },
    slug: { type: String, default: "" },
  },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  publishedAt: { type: Date },
  readTime: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  featured: { type: Boolean, default: false },
  deletionRequested: { type: Boolean, default: false },
  deletionRequestedBy: { type: ObjectId },
  deletionRequestedAt: { type: Date },
  metaTitle: { type: String, default: "" },
  metaDescription: { type: String, default: "" },
  createdBy: { type: ObjectId },
});

export const eventSchema = defineModel("event", {
  title: { type: String, required: true },
  description: { type: String, required: true },
  date: { type: Date, required: true },
  bannerImage: { type: String },
  registrationLink: { type: String },
  images: [{ type: String }],
  registrationForm: { type: Object },
  category: { type: String, default: "General" },
  status: { type: String, enum: ["upcoming", "completed", "cancelled"], default: "upcoming" },
  createdBy: { type: ObjectId },
});

export const registrationSchema = defineModel("registration", {
  eventId: { type: ObjectId, required: true },
  token: { type: String, required: true },
  data: { type: Object, default: {} },
  files: [{ type: String }],
  paid: { type: Boolean, default: false },
  attendance: {
    present: { type: Boolean, default: false },
    at: { type: Date },
    scannedBy: { type: ObjectId },
  },
});

export const gallerySchema = defineModel("gallery", {
  title: { type: String, required: true },
  description: { type: String },
  images: [{ type: String, required: true }],
  date: { type: Date, required: true },
  category: { type: String, default: "General" },
  type: { type: String, enum: ["darshan", "festival", "seva", "community", "other"], default: "darshan" },
  status: { type: String, enum: ["active", "inactive"], default: "active" },
  createdBy: { type: ObjectId },
});

export const heroBannerSchema = defineModel("heroBanner", {
  title: { type: String, required: true, trim: true },
  desktopImage: { type: String, required: true },
  mobileImage: { type: String, required: true },
  linkUrl: { type: String, default: "", trim: true },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  createdBy: { type: ObjectId },
});

export const importantDateSchema = defineModel("importantDate", {
  title: { type: String, required: true },
  date: { type: Date, required: true },
  description: { type: String },
  type: { type: String, enum: ["Ekadashi", "Festival", "Other"], default: "Other" },
  createdBy: { type: ObjectId },
});

export const mediaSchema = defineModel("media", {
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true },
  publicId: { type: String, required: true },
  format: { type: String },
  width: { type: Number },
  height: { type: Number },
  bytes: { type: Number },
  folder: { type: String, default: "media-library" },
  tags: { type: String, trim: true },
  uploadedBy: { type: ObjectId },
});

export const siteContentSchema = defineModel("siteContent", {
  key: { type: String, default: "main" },
  hero: {
    title: { type: String, default: sc.hero.title },
    subtitle: { type: String, default: sc.hero.subtitle },
    tagline: { type: String, default: sc.hero.tagline },
  },
  about: {
    heading: { type: String, default: "" },
    body: { type: String, default: "" },
  },
  contact: {
    phone: { type: String, default: sc.contact.phone },
    email: { type: String, default: sc.contact.email },
    address: { type: String, default: sc.contact.address },
    morningHours: { type: String, default: sc.contact.morningHours },
    eveningHours: { type: String, default: sc.contact.eveningHours },
  },
  navbar: {
    majorFestival: { type: String, default: "none" },
    customLink: {
      enabled: { type: Boolean, default: false },
      label: { type: String, default: "" },
      href: { type: String, default: "" },
    },
  },
  festival: {
    bannerDesktop: { type: String, default: sc.festival.bannerDesktop },
    bannerMobile: { type: String, default: sc.festival.bannerMobile },
  },
  construction: {
    videoUrl: { type: String, default: "" },
    videoId: { type: String, default: sc.construction.videoId },
    photos: {
      type: [sub({ url: { type: String, required: true }, caption: { type: String, default: "" } }, { _id: false })],
      default: () => sc.construction.photos.map((p) => ({ ...p })),
    },
    updatedAt: { type: Date },
  },
  updatedBy: { type: ObjectId },
});

export const donationPageSchema = defineModel("donationPage", {
  key: { type: String, default: "donations" },
  heroTitle: { type: String },
  heroSubtitle: { type: String },
  heroEyebrow: { type: String },
  bannerImage: { type: String },
  bannerMobileImage: { type: String },
  trusteeBannerImage: { type: String },
  annadaanImage: { type: String },
  goSevaImage: { type: String },
  annadaanTitle: { type: String },
  annadaanDescription: { type: String },
  goSevaTitle: { type: String },
  goSevaDescription: { type: String },
  donationOptions: [{ id: Number, category: String, title: String, amount: Number }],
  galleryImages: [String],
  impactItems: [{ title: String, text: String }],
  bankDetails: { beneficiaryName: String, bankName: String, accountNumber: String, ifsc: String },
  contact: { phone: String, email: String, note: String },
  updatedBy: { type: ObjectId },
});

export const contactMessageSchema = defineModel("contactMessage", {
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, trim: true, default: "" },
  subject: { type: String, trim: true, default: "General Enquiry" },
  message: { type: String, required: true, trim: true },
  authorization: { type: Boolean, default: false },
  status: { type: String, enum: ["new", "read", "responded"], default: "new" },
  source: { type: String, default: "contact-page" },
});

export const darshanSchema = defineModel("darshan", {
  vaikunthamId: { type: Number, required: true },
  imageUrl: { type: String, required: true },
  position: { type: Number, default: 0 },
  status: { type: String, enum: ["active"], default: "active" },
  syncedAt: { type: Date, default: Date.now },
});

export const templeDevoteeSchema = defineModel("templeDevotee", {
  name: { type: String, required: true, trim: true },
  dccEnrolledById: { type: Number, default: null },
  status: { type: String, enum: ["active", "hidden"], default: "active" },
});

const formFieldDef = {
  id: { type: String, required: true },
  type: {
    type: String,
    enum: ["text", "email", "tel", "number", "textarea", "select", "checkbox", "date"],
    default: "text",
  },
  label: { type: String, required: true },
  placeholder: { type: String, default: "" },
  required: { type: Boolean, default: false },
  options: [{ type: String }],
};

export const volunteerEventSchema = defineModel("volunteerEvent", {
  title: { type: String, required: true },
  description: { type: String, required: true },
  date: { type: Date, required: true },
  endDate: { type: Date },
  location: { type: String, default: "" },
  image: { type: String, default: "" },
  slots: { type: Number, default: 0 },
  filledSlots: { type: Number, default: 0 },
  category: { type: String, enum: ["festival", "weekly", "special", "outreach"], default: "festival" },
  requirements: { type: String, default: "" },
  status: { type: String, enum: ["active", "closed", "completed"], default: "active" },
  formFields: { type: [sub(formFieldDef, { _id: false })], default: [] },
  createdBy: { type: ObjectId },
});

export const volunteerRegistrationSchema = defineModel("volunteerRegistration", {
  eventId: { type: ObjectId, required: true },
  responses: { type: Mixed, default: {} },
  status: { type: String, enum: ["pending", "approved", "rejected", "completed"], default: "pending" },
});

export const festivalShowcaseSchema = defineModel("festivalShowcase", {
  title: { type: String, required: true },
  slug: { type: String, required: true },
  subtitle: { type: String },
  heroImage: { type: String },
  cardImage: { type: String },
  eventDate: { type: Date },
  location: { type: String },
  description: { type: String },
  status: { type: String, enum: ["upcoming", "completed", "annual"], default: "upcoming" },
  featured: { type: Boolean, default: false },
  featuredOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  ctaLabel: { type: String, default: "Donate Now" },
  ctaHref: { type: String },
  donateEnabled: { type: Boolean, default: true },
  customLink: { type: String, default: "" },
  gallery: [{ type: String }],
  schedule: [sub({ start: { type: String }, title: { type: String }, description: { type: String } }, { _id: false })],
  details: [sub({ heading: { type: String }, body: { type: String }, image: { type: String } }, { _id: false })],
  testimonials: [
    sub(
      {
        name: { type: String },
        role: { type: String },
        message: { type: String },
        rating: { type: Number, min: 1, max: 5 },
        avatar: { type: String },
      },
      { _id: false }
    ),
  ],
  createdBy: { type: ObjectId },
});

export const festivalDonationSchema = defineModel("festivalDonation", {
  title: { type: String, required: true },
  slug: { type: String, required: true },
  description: { type: String },
  images: [{ type: String }],
  active: { type: Boolean, default: true },
  donationOptions: [{ label: String, amount: Number, description: String }],
  eventId: { type: ObjectId },
  meta: { type: Object },
  createdBy: { type: ObjectId },
});

export const campaignerSchema = defineModel("campaigner", {
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  mobile: { type: String, required: true, trim: true },
  slug: { type: String, required: true },
  campaignType: { type: String, enum: ["SQFT", "JANMASHTAMI"], default: "SQFT" },
  referredByDevotee: { type: ObjectId, default: null },
  goalSqft: { type: Number, default: 0, min: 0, max: 100000 },
  message: { type: String, trim: true, maxlength: 300 },
  status: { type: String, enum: ["pending", "active", "hidden"], default: "pending" },
});

export const userSchema = defineModel("user", {
  name: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["user", "donations_admin", "blogs_admin", "shop_admin", "preacher", "admin"], default: "user" },
  allowedModules: { type: [String], default: [] },
  status: { type: String, enum: ["active", "inactive"], default: "active" },
  mustChangePassword: { type: Boolean, default: false },
  preferences: {
    newDonation: { type: Boolean, default: true },
    newDevotee: { type: Boolean, default: true },
    eventReminders: { type: Boolean, default: true },
    weeklyReport: { type: Boolean, default: false },
  },
});

export const donorIssueSchema = defineModel("donorIssue", {
  donorRecordId: { type: ObjectId, required: true },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  status: { type: String, enum: ["open", "in-progress", "resolved"], default: "open" },
  adminResponse: { type: String },
  respondedAt: { type: Date },
  respondedBy: { type: ObjectId },
});
