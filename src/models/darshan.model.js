const mongoose = require("mongoose");

// Mirrors the Vaikuntham admin panel's Daily Darshan photos. Kept as its
// own collection (rather than reusing `gallery`) so the automated sync
// never touches hand-curated gallery entries, and so a full replace of the
// darshan set is a simple "delete anything not in this payload" instead of
// having to filter by type/category first.
//
// vaikunthamId ties each doc back to its row in Vaikuntham's
// daily_darshans table — that's what makes darshan.controller.js's sync
// upsert-by-id (rather than blind insert) possible.
const darshanSchema = new mongoose.Schema({
  vaikunthamId: { type: Number, required: true, unique: true, index: true },
  imageUrl: { type: String, required: true },
  position: { type: Number, default: 0 }, // display order, newest first
  status: { type: String, enum: ["active"], default: "active" },
  syncedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
  versionKey: false,
});

darshanSchema.index({ position: 1 });

const darshanModel = mongoose.model("darshan", darshanSchema);

module.exports = { darshanModel };
