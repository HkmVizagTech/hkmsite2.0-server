const mongoose = require("mongoose");

// A donor-raised issue/query, tracked from submission through resolution.
// Kept simple deliberately — one message in, one response out, a status.
// If this needs to become a full back-and-forth thread later, that's a
// straightforward extension (an array of messages instead of one).
const donorIssueSchema = new mongoose.Schema(
  {
    donorRecordId: { type: mongoose.Schema.Types.ObjectId, ref: "donor", required: true, index: true },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ["open", "in-progress", "resolved"], default: "open" },
    adminResponse: { type: String },
    respondedAt: { type: Date },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true }
);

donorIssueSchema.index({ status: 1, createdAt: -1 });

const donorIssueModel = mongoose.model("donorIssue", donorIssueSchema);
module.exports = { donorIssueModel };
