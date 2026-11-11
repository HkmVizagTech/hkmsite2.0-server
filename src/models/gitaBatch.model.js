const mongoose = require("mongoose");

// A run of the free "Understand Gita in 18 Days" course for one age group and one language.
// New registrations are placed in the earliest open batch that matches their age group and language.
const gitaBatchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    ageGroup: { type: String, enum: ["adults", "youth", "kids"], required: true },
    language: { type: String, enum: ["English", "Telugu"], required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    classTime: { type: String, trim: true, default: "", maxlength: 80 },
    whatsappLink: { type: String, trim: true, default: "", maxlength: 300 },
    capacity: { type: Number, default: 0 }, // 0 = no limit
    registrationOpen: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { timestamps: true, collection: "gita_batches" }
);

gitaBatchSchema.index({ ageGroup: 1, language: 1, startDate: 1 });

const gitaBatchModel = mongoose.model("GitaBatch", gitaBatchSchema);
module.exports = { gitaBatchModel };
