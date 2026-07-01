const mongoose = require("mongoose");

const donationPageSchema = new mongoose.Schema({
  key: { type: String, default: "donations", unique: true },
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
  donationOptions: [{
    id: Number,
    category: String,
    title: String,
    amount: Number,
  }],
  galleryImages: [String],
  impactItems: [{
    title: String,
    text: String,
  }],
  bankDetails: {
    beneficiaryName: String,
    bankName: String,
    accountNumber: String,
    ifsc: String,
  },
  contact: {
    phone: String,
    email: String,
    note: String,
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
}, {
  timestamps: true,
  versionKey: false,
});

const donationPageModel = mongoose.model("donationPage", donationPageSchema);

module.exports = { donationPageModel };
