const mongoose = require("mongoose");

// Generic atomic counter, used for generating sequential IDs (like donor
// IDs) safely even if two requests try to create one at the exact same
// moment. findOneAndUpdate with $inc is atomic at the MongoDB level, so
// two concurrent calls can never receive the same number.
const counterSchema = new mongoose.Schema(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { versionKey: false }
);
const counterModel = mongoose.model("counter", counterSchema);

async function getNextSequence(name) {
  const doc = await counterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
}

module.exports = { getNextSequence };
