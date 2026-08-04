const mongoose = require("mongoose");

const volunteerEventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    date: { type: Date, required: true },
    endDate: { type: Date },
    location: { type: String, default: "" },
    image: { type: String, default: "" },
    slots: { type: Number, default: 0 },
    filledSlots: { type: Number, default: 0 },
    category: {
      type: String,
      enum: ["festival", "weekly", "special", "outreach"],
      default: "festival",
    },
    requirements: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "closed", "completed"],
      default: "active",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

volunteerEventSchema.index({ status: 1, date: 1 });

const volunteerRegistrationSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "volunteerEvent",
      required: true,
    },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    message: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "completed"],
      default: "pending",
    },
  },
  { timestamps: true, versionKey: false }
);

volunteerRegistrationSchema.index({ eventId: 1 });
volunteerRegistrationSchema.index({ email: 1 });

const volunteerEventModel = mongoose.model("volunteerEvent", volunteerEventSchema);
const volunteerRegistrationModel = mongoose.model("volunteerRegistration", volunteerRegistrationSchema);

module.exports = { volunteerEventModel, volunteerRegistrationModel };
