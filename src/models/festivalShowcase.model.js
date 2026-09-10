const mongoose = require("mongoose");

const scheduleItemSchema = new mongoose.Schema(
  {
    start: { type: String }, // "6:00 AM" — time or "Day 1"
    title: { type: String },
    description: { type: String },
  },
  { _id: false }
);

const detailSectionSchema = new mongoose.Schema(
  {
    heading: { type: String },
    body: { type: String },
    image: { type: String },
  },
  { _id: false }
);

const testimonialSchema = new mongoose.Schema(
  {
    name: { type: String },
    role: { type: String }, // e.g. "Devotee, Vizag"
    message: { type: String },
    rating: { type: Number, min: 1, max: 5 },
    avatar: { type: String },
  },
  { _id: false }
);

const festivalShowcaseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true }, // for URL
    subtitle: { type: String },
    heroImage: { type: String }, // big top banner
    cardImage: { type: String }, // shown on the /festival cards (falls back to heroImage)
    eventDate: { type: Date },
    location: { type: String },
    description: { type: String }, // short blurb for cards + intro
    status: {
      type: String,
      enum: ["upcoming", "completed", "annual"],
      default: "upcoming",
    },
    featured: { type: Boolean, default: false }, // highlight biggest festivals (Janmashtami, Radhashtami…)
    active: { type: Boolean, default: true },
    ctaLabel: { type: String, default: "Donate Now" },
    ctaHref: { type: String }, // link to the festival's donation page, e.g. /festival/janmashtami
    gallery: [{ type: String }],
    schedule: [scheduleItemSchema],
    details: [detailSectionSchema], // rich recap sections (used once the festival has happened)
    testimonials: [testimonialSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

const festivalShowcaseModel = mongoose.model("festivalShowcase", festivalShowcaseSchema);

module.exports = { festivalShowcaseModel };