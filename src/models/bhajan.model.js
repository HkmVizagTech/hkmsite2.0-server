const mongoose = require("mongoose");

// Vaishnava bhajan library: lyrics (verse by verse, several scripts) plus
// optional audio recordings. See the shared bhajans spec for the contract.

const LANGS = ["en", "te", "hi"];

const langLines = {};
const langText = {};
for (const l of LANGS) {
  langLines[l] = { type: [String], default: undefined };
  langText[l] = { type: String };
}

const verseSchema = new mongoose.Schema(
  {
    number: { type: Number },
    text: langLines,
    translation: langText,
    wordByWord: {
      en: {
        type: [new mongoose.Schema({ word: String, meaning: String }, { _id: false })],
        default: undefined,
      },
    },
  },
  { _id: false }
);

const trackSchema = new mongoose.Schema({
  singer: { type: String, default: "", trim: true },
  url: { type: String, required: true },
  duration: { type: Number, default: 0, min: 0 }, // seconds
  order: { type: Number, default: 0 },
  bytes: { type: Number, default: 0, min: 0 },
  // Start second of each verse, index-aligned to bhajan.verses (may be shorter or empty).
  verseTimes: { type: [Number], default: [] },
});

const bhajanSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    artist: { type: String, default: "", trim: true },
    authorSlug: { type: String, default: "", lowercase: true, trim: true },
    subtitle: { type: String, default: "", trim: true },
    categories: { type: [String], default: [] },
    moods: { type: [String], default: [] },
    festivals: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    coverImage: { type: String, default: "" },
    isFeatured: { type: Boolean, default: false },
    isPublished: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    tracks: { type: [trackSchema], default: [] },
    verses: { type: [verseSchema], default: [] },
    lyricsText: { type: String, default: "" },
    source: {
      name: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    playCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false }
);

// Search is a case-insensitive regex on title/artist/lyricsText (small
// collection), so no text index. These serve filters and sorts.
bhajanSchema.index({ isPublished: 1, categories: 1 });
bhajanSchema.index({ isPublished: 1, moods: 1 });
bhajanSchema.index({ isPublished: 1, festivals: 1 });
bhajanSchema.index({ isPublished: 1, authorSlug: 1 });
bhajanSchema.index({ isPublished: 1, isFeatured: -1, sortOrder: -1 });
bhajanSchema.index({ isPublished: 1, playCount: -1 });
bhajanSchema.index({ isPublished: 1, createdAt: -1 });

const bhajanModel = mongoose.models.bhajan || mongoose.model("bhajan", bhajanSchema);

module.exports = { bhajanModel, BHAJAN_LANGS: LANGS };
