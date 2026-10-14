// Imports scripts/vaishnav-calendar-2026.json into important_dates. Safe to re-run:
// entries whose title and date already exist are skipped.
//   DATABASE_URL=postgres://... node scripts/seed-vaishnav-calendar.js

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { importantDates } from "../src/db/tables.js";
import { closeDb } from "../src/db/pg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function seed() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");

  const events = JSON.parse(fs.readFileSync(path.join(__dirname, "vaishnav-calendar-2026.json"), "utf-8"));
  console.log(`Found ${events.length} events in JSON.`);

  let created = 0;
  let skipped = 0;
  for (const event of events) {
    const date = new Date(event.date);
    if (await importantDates.findOne({ title: event.title, date })) {
      skipped++;
      continue;
    }
    await importantDates.insert({
      title: event.title,
      date,
      description: event.description || "",
      type: event.type || "Other",
    });
    created++;
  }
  console.log(`Done. Created: ${created}, Skipped (already exist): ${skipped}`);
}

seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(closeDb);
