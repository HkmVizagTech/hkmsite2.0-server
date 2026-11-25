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

// General volunteer sign-up from the website's /volunteer page (not tied to a particular event).
const volunteerSignupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, index: true }, // 10-digit Indian mobile
    email: { type: String, trim: true, lowercase: true, default: "", maxlength: 160 },
    city: { type: String, trim: true, default: "", maxlength: 120 },
    age: { type: Number },
    gender: { type: String, enum: ["", "male", "female", "other"], default: "" },
    occupation: { type: String, trim: true, default: "", maxlength: 160 }, // student / working / etc, free text
    interests: { type: [String], default: [] }, // ways to serve
    availability: { type: [String], default: [] }, // e.g. weekdays, weekends, festivals
    startDate: { type: Date }, // preferred start date
    message: { type: String, trim: true, default: "", maxlength: 1000 },
    status: { type: String, enum: ["new", "contacted", "active", "not_reachable"], default: "new" },
    notes: { type: String, trim: true, default: "", maxlength: 1000 }, // admin's own note
    utm: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, versionKey: false, collection: "volunteer_signups" }
);
volunteerSignupSchema.index({ createdAt: -1 });

const volunteerEventModel = mongoose.model("volunteerEvent", volunteerEventSchema);
const volunteerRegistrationModel = mongoose.model("volunteerRegistration", volunteerRegistrationSchema);

const volunteerSignupModel = mongoose.model("volunteerSignup", volunteerSignupSchema);

module.exports = { volunteerEventModel, volunteerRegistrationModel, volunteerSignupModel };
