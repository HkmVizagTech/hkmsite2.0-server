const mongoose = require("mongoose");

// Editorial data for bhajan taxonomy pages (composers, categories, moods,
// festivals): translated names/descriptions and an image. Song counts are
// computed live from the bhajans, never stored here.

const TAXON_TYPES = ["author", "category", "mood", "festival"];
const TAXON_LANGS = ["en", "te", "hi"];

const langObj = () => ({
  en: { type: String, default: "" },
  te: { type: String, default: "" },
  hi: { type: String, default: "" },
});

const bhajanTaxonSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: TAXON_TYPES },
    slug: { type: String, required: true, lowercase: true, trim: true },
    name: langObj(),
    description: langObj(),
    image: { type: String, default: "" },
    order: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, collection: "bhajan_taxons" }
);

bhajanTaxonSchema.index({ type: 1, slug: 1 }, { unique: true });

const bhajanTaxonModel =
  mongoose.models.bhajanTaxon || mongoose.model("bhajanTaxon", bhajanTaxonSchema);

module.exports = { bhajanTaxonModel, TAXON_TYPES, TAXON_LANGS };
