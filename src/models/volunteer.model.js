const mongoose = require("mongoose");

const formFieldSchema = new mongoose.Schema(
  {
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
  },
  { _id: false }
);

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
    formFields: { type: [formFieldSchema], default: [] },
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
    responses: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "completed"],
      default: "pending",
    },
  },
  { timestamps: true, versionKey: false }
);

volunteerRegistrationSchema.index({ eventId: 1 });

const volunteerEventModel = mongoose.model("volunteerEvent", volunteerEventSchema);
const volunteerRegistrationModel = mongoose.model("volunteerRegistration", volunteerRegistrationSchema);

module.exports = { volunteerEventModel, volunteerRegistrationModel };
