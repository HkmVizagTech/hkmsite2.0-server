// Ensures the canonical festival-donation campaigns exist and deactivates test records.
// Idempotent.
//   npm run seed:festival-donations                    also sets the navbar highlight to "none"
//   npm run seed:festival-donations -- --keep-navbar   leave site-content/navbar alone
// Reads DATABASE_URL.

import "dotenv/config";

import { query, closeDb } from "../src/db/pg.js";
import { siteContent } from "../src/db/tables.js";
import { siteContentDefaults } from "../src/domain/siteContent.js";
import { ensureDefaultFestivalDonations } from "../src/services/festivalDonationBootstrap.service.js";

async function seed() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");

  const { created, skipped, deactivated } = await ensureDefaultFestivalDonations();
  created.forEach((s) => console.log(`  + created ${s}`));
  skipped.forEach((s) => console.log(`  = kept existing ${s}`));
  deactivated.forEach((t) => console.log(`  - deactivated test record: ${t}`));

  if (process.argv.includes("--keep-navbar")) {
    console.log("Skipping navbar highlight update (--keep-navbar).");
  } else {
    const defaults = siteContentDefaults();
    await siteContent.insert({ key: "main", ...defaults }, { onConflictDoNothing: true });
    const { rows } = await query(
      `UPDATE site_content
          SET navbar = jsonb_set(COALESCE(navbar, '{}'::jsonb), '{majorFestival}', '"none"'), updated_at = now()
        WHERE key = 'main' RETURNING navbar`
    );
    console.log(
      `Navbar highlight set to "none". current value: navbar.majorFestival = ${rows[0]?.navbar?.majorFestival}`
    );
  }

  console.log(`\nDone. Created ${created.length}, skipped ${skipped.length}, deactivated ${deactivated.length}.`);
}

seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(closeDb);
