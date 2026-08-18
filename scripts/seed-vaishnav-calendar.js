/**
 * Seed script — imports vaishnav-calendar-2026.json into the importantDate
 * MongoDB collection.  Run once:
 *
 *   node scripts/seed-vaishnav-calendar.js
 *
 * Requires MONGO_URI in env or falls back to localhost:27017/hkmvizag.
 */

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/hkmvizag";

const importantDateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String },
    type: { type: String, enum: ["Ekadashi", "Festival", "Other"], default: "Other" },
  },
  { timestamps: true, versionKey: false }
);

const ImportantDate = mongoose.model("importantDate", importantDateSchema);

async function seed() {
  console.log(`Connecting to ${MONGO_URI}…`);
  await mongoose.connect(MONGO_URI);
  console.log("Connected.");

  const jsonPath = path.join(__dirname, "vaishnav-calendar-2026.json");
  const raw = fs.readFileSync(jsonPath, "utf-8");
  const events = JSON.parse(raw);

  console.log(`Found ${events.length} events in JSON.`);

  // Upsert each event (skip if title+date already exists)
  let created = 0;
  let skipped = 0;

  for (const event of events) {
    const existing = await ImportantDate.findOne({
      title: event.title,
      date: new Date(event.date),
    });

    if (existing) {
      skipped++;
      continue;
    }

    await ImportantDate.create({
      title: event.title,
      date: new Date(event.date),
      description: event.description || "",
      type: event.type || "Other",
    });
    created++;
  }

  console.log(`Done. Created: ${created}, Skipped (already exist): ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
