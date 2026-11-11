const mongoose = require("mongoose");

// Sign-ups for the free "Understand Gita in 18 Days" course (public form on /understand-gita).
const gitaCourseRegistrationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    mobile: { type: String, required: true, index: true }, // 10 digits
    email: { type: String, trim: true, lowercase: true, default: "" },
    city: { type: String, trim: true, default: "", maxlength: 80 },
    batch: { type: String, enum: ["adults", "youth", "kids"], required: true },
    language: { type: String, trim: true, default: "", maxlength: 40 },
    preferredTime: { type: String, trim: true, default: "", maxlength: 60 },
    kidName: { type: String, trim: true, default: "", maxlength: 120 },
    note: { type: String, trim: true, default: "", maxlength: 500 },
    status: { type: String, enum: ["new", "contacted", "added", "completed", "dropped"], default: "new" },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: "GitaBatch", default: null, index: true },
  },
  { timestamps: true, collection: "gita_course_registrations" }
);

const gitaCourseRegistrationModel = mongoose.model("GitaCourseRegistration", gitaCourseRegistrationSchema);
module.exports = { gitaCourseRegistrationModel };
