/**
 * One-time import of the October 2026 batch of blog articles
 * (src/seed/blog-drafts: index.json + <slug>.html + covers/<slug>.webp).
 *
 * Runs at server boot like the other bootstrap seeders, but only ONCE per
 * database: after a successful run it records a marker in the
 * `bootstrap_runs` collection, so posts an admin later edits or deletes are
 * never re-created. Until then it is idempotent — slugs that already exist
 * are skipped, and the marker is only written when every article was either
 * created or already present (a failed one is retried on the next boot).
 *
 * Covers (from guptvrindavandham.org, used with HKM Jaipur's permission)
 * are uploaded to R2 the same way the admin editor uploads them.
 *
 * Set BLOG_DRAFTS_IMPORT=off to disable.
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { blogModel, BLOG_CATEGORIES } = require("../models/blog.model");
const { uploadToR2 } = require("../utils/r2");

const RUN_KEY = "blog-drafts-2026-10";
const SEED_DIR = path.join(__dirname, "..", "seed", "blog-drafts");
const AUTHOR = { name: "Hare Krishna Movement Vizag", avatar: "", bio: "", slug: "" };

async function ensureBlogDrafts() {
  if (String(process.env.BLOG_DRAFTS_IMPORT || "").toLowerCase() === "off") return;

  const runs = mongoose.connection.collection("bootstrap_runs");
  if (await runs.findOne({ key: RUN_KEY })) return;

  const indexPath = path.join(SEED_DIR, "index.json");
  if (!fs.existsSync(indexPath)) return;
  const entries = JSON.parse(fs.readFileSync(indexPath, "utf8"));

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const e of entries) {
    try {
      if (!e.slug || !e.title || !e.file) throw new Error("entry missing slug/title/file");
      if (await blogModel.exists({ slug: e.slug })) {
        skipped++;
        continue;
      }
      const content = fs.readFileSync(path.join(SEED_DIR, e.file), "utf8");

      let coverImage = "";
      if (e.coverImageFile) {
        const coverPath = path.join(SEED_DIR, e.coverImageFile);
        if (fs.existsSync(coverPath)) {
          const up = await uploadToR2(coverPath, "blogs");
          coverImage = up && up.secure_url ? up.secure_url : "";
        }
      }

      await blogModel.create({
        title: e.title,
        slug: e.slug,
        excerpt: e.excerpt || "",
        content,
        coverImage,
        category: BLOG_CATEGORIES.includes(e.category) ? e.category : "Spiritual Knowledge",
        tags: Array.isArray(e.tags) ? e.tags : [],
        author: AUTHOR,
        status: "published",
        featured: false,
        metaTitle: e.metaTitle || "",
        metaDescription: e.metaDescription || e.excerpt || "",
      });
      created++;
    } catch (err) {
      failed++;
      console.error(`[blogDrafts] ${e && e.slug}: ${err && err.message ? err.message : err}`);
    }
  }

  console.log(`[blogDrafts] import: ${created} created, ${skipped} already present, ${failed} failed`);
  if (failed === 0) {
    await runs.insertOne({ key: RUN_KEY, created, skipped, at: new Date() });
  }
}

module.exports = { ensureBlogDrafts };
