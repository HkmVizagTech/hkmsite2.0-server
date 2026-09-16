/**
 * Seed script — creates the default devotional shop categories for the
 * temple store. Idempotent: only inserts categories whose slug doesn't
 * already exist, so it is safe to run again (new ones added later are
 * inserted, existing ones are left untouched — nothing is overwritten).
 *
 *   npm run seed:shop-categories
 *
 * Requires MONGO_URI / MONGODB_URI in env (or .env), falls back to
 * localhost:27017/hkmvizag.
 */

require("dotenv").config();

const mongoose = require("mongoose");
const { DEFAULT_SHOP_CATEGORIES, slugify, ensureDefaultShopCategories } = require("../src/services/shopBootstrap.service");

const MONGO_URI = (process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://localhost:27017/hkmvizag").replace(
  /\/+$/,
  ""
);

async function seed() {
  console.log(`Connecting to ${MONGO_URI}…`);
  await mongoose.connect(MONGO_URI);
  console.log("Connected.");

  const { created, createdNames, skipped } = await ensureDefaultShopCategories();
  createdNames.forEach((name) => console.log(`  + ${name}`));
  console.log(`\nDone. Created ${created} category(ies), skipped ${skipped} existing.`);
  await mongoose.connection.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});