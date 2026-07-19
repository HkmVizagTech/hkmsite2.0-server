const mongoose = require("mongoose");

// GVD-style 13 categories (matches guptvrindavandham.org/blogs structure)
const BLOG_CATEGORIES = [
  "Krishna Katha",
  "Vaishnava Songs and Prayers",
  "Our Acharyas",
  "Spiritual Knowledge",
  "Sacred Festivals & Occasions",
  "Spiritual News & Events",
  "Spiritual Charity",
  "Timeless Wisdom",
  "Divine Poetics",
  "Krishna Consciousness",
  "Recipes",
  "Pilgrimage",
  "Other",
];

const blogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    excerpt: { type: String, default: "" },
    content: { type: String, required: true },
    coverImage: { type: String, default: "" },
    images: [{ type: String }],
    category: {
      type: String,
      enum: BLOG_CATEGORIES,
      default: "Spiritual Knowledge",
      index: true,
    },
    tags: [{ type: String, trim: true }],

    // Author block - GVD shows author photo + name on every card
    author: {
      name: { type: String, default: "Admin" },
      avatar: { type: String, default: "" },
      bio: { type: String, default: "" },
      slug: { type: String, default: "" },
    },

    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    publishedAt: { type: Date },
    readTime: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    featured: { type: Boolean, default: false, index: true },

    // A blogs_admin account cannot delete a post outright - their delete
    // call sets these instead, and an actual admin must approve (deletes
    // for real) or reject (clears these back to false/null) via the
    // dedicated endpoints below.
    deletionRequested: { type: Boolean, default: false, index: true },
    deletionRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    deletionRequestedAt: { type: Date },

    metaTitle: { type: String, default: "" },
    metaDescription: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

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

blogSchema.index({ title: "text", excerpt: "text", content: "text" });
blogSchema.index({ status: 1, publishedAt: -1 });
blogSchema.index({ category: 1, status: 1, publishedAt: -1 });

const blogModel = mongoose.model("blog", blogSchema);

module.exports = { blogModel, BLOG_CATEGORIES };
