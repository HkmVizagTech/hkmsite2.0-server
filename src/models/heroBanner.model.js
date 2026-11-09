const mongoose = require("mongoose");

const heroBannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    desktopImage: { type: String, required: true },
    mobileImage: { type: String, required: true },
    linkUrl: { type: String, default: "", trim: true },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true, index: true },
    // Optional schedule. A banner shows only from startsAt (if set) until endsAt (if set), while it is also active.
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

heroBannerSchema.index({ active: 1, order: 1 });

const heroBannerModel = mongoose.model("heroBanner", heroBannerSchema);

module.exports = { heroBannerModel };
