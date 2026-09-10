const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  date: { type: Date, required: true },
  /* Hero/banner image for the event — a persistent URL (R2 / media library).
     Falls back to images[0] in the UI when not set. */
  bannerImage: { type: String },
  /* When set, the event links out to this landing page (registrations
     happen there) instead of using the on-page registration form. */
  registrationLink: { type: String },
  images: [{ type: String }], // URLs or filenames
  registrationForm: { type: Object },
  category: { type: String, default: "General" },
  status: { type: String, enum: ["upcoming", "completed", "cancelled"], default: "upcoming" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }
}, {
  timestamps: true,
  versionKey: false
});

const eventModel = mongoose.model("event", eventSchema);

module.exports = { eventModel };
