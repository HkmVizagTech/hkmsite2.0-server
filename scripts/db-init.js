import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../src/config/env.js";
import { closeDb, one, query } from "../src/db/pg.js";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../docs/postgres-migration/schema.sql");

const MARK = "-- ==== UPGRADES";
const exists = await one("SELECT to_regclass('public.users') AS t");
const sql = await readFile(schemaPath, "utf8");
if (exists.t) {
  // The base schema is already there; apply only the idempotent upgrade section.
  const at = sql.indexOf(MARK);
  if (at >= 0) await query(sql.slice(at));
  console.log("schema already present, upgrades applied");
} else {
  await query(sql);
  console.log("schema created");
}
await closeDb();
