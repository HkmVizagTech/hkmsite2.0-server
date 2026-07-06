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
      phone: { type: String, default: "+91 98765 43210" },
      email: { type: String, default: "info@harekrishnavizag.org" },
      address: { type: String, default: "Hare Krishna Marg, Visakhapatnam, Andhra Pradesh, India - 530003" },
      morningHours: { type: String, default: "4:30 AM - 1:00 PM" },
      eveningHours: { type: String, default: "4:00 PM - 8:30 PM" },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

const siteContentModel = mongoose.model("siteContent", siteContentSchema);

module.exports = { siteContentModel };
