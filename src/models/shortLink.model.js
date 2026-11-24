const mongoose = require("mongoose");

// A short link for a (usually UTM-tagged) page on the website, e.g.
//   harekrishnavizag.org/go/kp-manas  ->  /kartik-purnima?utm_source=call&utm_medium=whatsapp&utm_campaign=manas-kartik-purnima
// Created in Admin → Donations → UTM Builder. `path` is the site-relative destination including its query string
// (never an outside address), so a short link can only ever lead to a page on this website.
const shortLinkSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 40 },
    path: { type: String, required: true, trim: true, maxlength: 2000 },
    label: { type: String, trim: true, default: "", maxlength: 120 },
    clicks: { type: Number, default: 0 },
    lastClickAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false, collection: "short_links" }
);

const shortLinkModel = mongoose.model("ShortLink", shortLinkSchema);
module.exports = { shortLinkModel };
