const mongoose = require("mongoose");

const contactMessageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true, default: "" },
    subject: { type: String, trim: true, default: "General Enquiry" },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: ["new", "read", "responded"], default: "new", index: true },
    source: { type: String, default: "contact-page" },
  },
  { timestamps: true, versionKey: false }
);

contactMessageSchema.index({ createdAt: -1 });

const contactMessageModel = mongoose.model("contactMessage", contactMessageSchema);

module.exports = { contactMessageModel };
