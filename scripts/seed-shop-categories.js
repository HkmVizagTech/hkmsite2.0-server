// Idempotent: inserts default shop categories whose slug is missing. Run: npm run seed:shop-categories
// Requires DATABASE_URL (env or .env).
import "dotenv/config";

import { ensureDefaultShopCategories } from "../src/services/shopBootstrap.service.js";
import { closeDb } from "../src/db/pg.js";

async function seed() {
  const { created, createdNames, skipped } = await ensureDefaultShopCategories();
  createdNames.forEach((name) => console.log(`  + ${name}`));
  console.log(`\nDone. Created ${created} category(ies), skipped ${skipped} existing.`);
  await closeDb();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
