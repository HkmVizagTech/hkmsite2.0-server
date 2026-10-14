import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { blogs } from "../db/tables.js";
import { query } from "../db/pg.js";
import { BLOG_CATEGORIES, computeReadTime } from "../domain/blog.js";
import { uploadToR2 } from "../utils/r2.js";
const __dirname = dirname(fileURLToPath(import.meta.url));

const RUN_KEY = "blog-drafts-2026-10";
const SEED_DIR = path.join(__dirname, "..", "seed", "blog-drafts");
const AUTHOR = { name: "Hare Krishna Movement Vizag", avatar: "", bio: "", slug: "" };

async function ensureBlogDrafts() {
  if (String(process.env.BLOG_DRAFTS_IMPORT || "").toLowerCase() === "off") return;

  const done = await query("SELECT 1 FROM bootstrap_runs WHERE name = $1", [RUN_KEY]);
  if (done.rowCount) return;

  const indexPath = path.join(SEED_DIR, "index.json");
  if (!fs.existsSync(indexPath)) return;
  const entries = JSON.parse(fs.readFileSync(indexPath, "utf8"));

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const e of entries) {
    try {
      if (!e.slug || !e.title || !e.file) throw new Error("entry missing slug/title/file");
      if (await blogs.exists({ slug: e.slug })) {
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

      await blogs.insert({
        title: e.title,
        slug: e.slug,
        excerpt: e.excerpt || "",
        content,
        readTime: computeReadTime(content),
        publishedAt: new Date(),
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
    await query("INSERT INTO bootstrap_runs (name) VALUES ($1) ON CONFLICT DO NOTHING", [RUN_KEY]);
  }
}

export { ensureBlogDrafts };
