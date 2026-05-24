const mongoose = require("mongoose");

const blogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    excerpt: { type: String, default: "" }, // short summary for cards / SEO
    content: { type: String, required: true }, // rich HTML from CKEditor
    coverImage: { type: String, default: "" }, // Cloudinary URL
    images: [{ type: String }], // additional images uploaded with the post (for in-content use)
    category: {
      type: String,
      enum: ["Spirituality", "Festivals", "Vizag Guide", "Recipes", "Philosophy", "General"],
      default: "General",
      index: true,
    },
    tags: [{ type: String, trim: true }],
    author: { type: String, default: "Admin" }, // display name
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    publishedAt: { type: Date },
    readTime: { type: Number, default: 0 }, // minutes, computed on save
    views: { type: Number, default: 0 },
    metaTitle: { type: String, default: "" },
    metaDescription: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

// Compute reading time from content (rough: ~200 words/min)
blogSchema.pre("save", function (next) {
  if (this.isModified("content")) {
    const text = this.content.replace(/<[^>]*>/g, " ").trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    this.readTime = Math.max(1, Math.ceil(words / 200));
  }
  if (this.isModified("status") && this.status === "published" && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

// Helpful indexes
blogSchema.index({ title: "text", excerpt: "text", content: "text" });
blogSchema.index({ status: 1, publishedAt: -1 });

const blogModel = mongoose.model("blog", blogSchema);
module.exports = { blogModel };
