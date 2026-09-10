const mongoose = require("mongoose");

// Singleton config for the /ekadashi campaign donation page. Only one record
// (key = "ekadashi") ever exists. The `content` blob stores the editable
// campaign fields; the controller merges with DEFAULT_CAMPAIGN before returning
// so the client always receives a fully-populated object even if the admin
// has only edited a few fields.

const ekadashiCampaignSchema = new mongoose.Schema(
  {
    key: { type: String, default: "ekadashi", unique: true },
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

const ekadashiCampaignModel = mongoose.model(
  "ekadashiCampaign",
  ekadashiCampaignSchema
);

module.exports = { ekadashiCampaignModel };
