import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../src/config/env.js";
import { closeDb, one, query } from "../src/db/pg.js";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../docs/postgres-migration/schema.sql");

const exists = await one("SELECT to_regclass('public.users') AS t");
if (exists.t) {
  console.log("schema already present, nothing to do");
} else {
  await query(await readFile(schemaPath, "utf8"));
  console.log("schema created");
}
await closeDb();
