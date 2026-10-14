/**
 * Seed script — ensures the canonical festival-donation campaigns
 * (Radhashtami, Govardhan Puja, Ekadashi) exist and deactivates test/junk
 * records so the home/donations "Festival Donations" section shows real
 * campaigns. Idempotent; safe to run again.
 *
 *   npm run seed:festival-donations            # default: also hides the navbar highlight
 *   npm run seed:festival-donations -- --keep-navbar   # don't touch site-content/navbar
 *
 * Requires MONGO_URI / MONGODB_URI in env (or .env), falls back to
 * localhost:27017/hkmvizag.
 */

import "dotenv/config";

import mongoose from "mongoose";
import { ensureDefaultFestivalDonations } from "../src/services/festivalDonationBootstrap.service.js";
import { siteContentModel } from "../src/models/siteContent.model.js";

const MONGO_URI = (process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://localhost:27017/hkmvizag").replace(
  /\/+$/,
  ""
);

async function seed() {
  console.log(`Connecting to ${MONGO_URI}…`);
  await mongoose.connect(MONGO_URI);
  console.log("Connected.");

  const { created, skipped, deactivated } = await ensureDefaultFestivalDonations();
  created.forEach((s) => console.log(`  + created ${s}`));
  skipped.forEach((s) => console.log(`  = kept existing ${s}`));
  deactivated.forEach((t) => console.log(`  - deactivated test record: ${t}`));

  const keepNavbar = process.argv.includes("--keep-navbar");
  if (keepNavbar) {
    console.log("Skipping navbar highlight update (--keep-navbar).");
  } else {
    const content = await siteContentModel.findOneAndUpdate(
      { key: "main" },
      { $set: { "navbar.majorFestival": "none" } },
      { new: true, upsert: true }
    );
    console.log(`Navbar highlight set to "none" (was auto-picking e.g. Radhashtami around its date).`);
    console.log(`  current value: navbar.majorFestival = ${content.navbar && content.navbar.majorFestival}`);
  }

  console.log(`\nDone. Created ${created.length}, skipped ${skipped.length}, deactivated ${deactivated.length}.`);
  await mongoose.connection.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});