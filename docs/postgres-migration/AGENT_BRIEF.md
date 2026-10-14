# Porting brief: Mongoose -> Postgres (hkmsite2.0-server)

You are porting one slice of the server from Mongoose/MongoDB to plain `pg` + SQL. Several people port other slices at the same time, in the same checkout, so stay inside your file list.

## Ground rules
- Repo: `/Users/giridhar/Developer/hkm-vizag/hkmsite2.0-server`, branch `postgres-migration`. **Do not run any git command that changes state** (no commit/checkout/stash/reset). The lead commits. `git diff` / `git status` are fine.
- ES modules, modern style: `import`/`export`, named exports, `node:` built-ins, `async/await`, optional chaining, `const`. **Keep comments minimal**: delete the long narrative comments in files you rewrite; keep at most a short line for a non-obvious "why".
- Do not run `npm install`. Needed deps are present (`pg`, `sanitize-html`).
- **Never load the real `.env` and never connect to MongoDB Atlas.** All testing uses the sanitized local environment below. External services (Razorpay, DCC, Gupshup, Meta, R2, Delhivery...) have no credentials locally; code must keep behaving sensibly when they are unconfigured.
- Do not edit `src/db/*`, `app.js`, `index.js`, `docs/postgres-migration/schema.sql`, `src/models/*` or files owned by another slice. If you need something from the shared layer (missing filter operator, new column, new index, schema change), implement it locally with SQL in your own files and **list the request in your final report**. Schema/column changes: describe the exact DDL in the report; the lead applies it.
- Keep every exported function's **name, parameters and return shape** unchanged, so files in other slices that call yours keep working. Documents you return are now **plain objects** (camelCase, `_id` as a 24-hex string, nested objects rebuilt, nulls omitted), exactly the shape the API returned before. So remove `.lean()`, `.toObject()`, `.save()`, `.populate()`, `.exec()`, ObjectId methods like `.equals()`, `mongoose.Types.ObjectId`, `isValidObjectId`. Use `isId` from `src/db/pg.js` for id format checks.
- Stop importing `mongoose` and `src/models/*` from your files. If a model file has non-DB helper functions your code needs (e.g. `resolvePurchasable`, `calculateShipping`, `BLOG_CATEGORIES`), **copy** them to `src/domain/<name>.js` and import from there (do not delete them from the model file; other slices may still import it until the lead removes the models).
- Behavior must match the old API: same routes, status codes, JSON shapes, field names, sort order, pagination, rounding, validation messages. Where Mongo's order was unspecified, add a deterministic tie-breaker (`..., id`).
- Intentional behavior changes are only the ones listed under "Fixes" in your assignment. Record every deviation in your report.

## Data layer (read `src/db/pg.js`, `src/db/table.js`, `src/db/tables.js` first)
- `import { donations, donors, ... } from "../db/tables.js"` gives repos with Mongo-style filters: `find(filter, {sort, skip, limit, fields})`, `findOne`, `findById`, `count`, `distinct`, `insert`, `updateById`, `updateOne`, `updateMany`, `upsert`, `deleteById`, `deleteMany`, plus `fromRow`, `fieldToCol`.
- Filters: equality/null, `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex`, `$or/$and/$nor`, dotted nested names (`upiFallback.status`), `_id`, and `$raw: ["sql with ? placeholders", [params]]`. Patches: plain fields, `$set`, `$inc`, `$unset`. `insert` returns the new document; `updateById/updateOne` return the updated document or `null` when nothing matched (use a guard filter such as `{ status: { $ne: "completed" } }` for atomic claims).
- Anything beyond this (aggregations, joins, `GROUP BY`, `FOR UPDATE`, transactions) is hand-written SQL via `query` / `many` / `one` / `tx` from `src/db/pg.js`; map rows to documents with `repo.fromRow(row)` when you return documents. Parameterize everything (`$1`...), never string-concatenate user input; only whitelisted column names may be interpolated.
- Postgres columns are snake_case (see `docs/postgres-migration/schema.sql`). `numeric` and `int8` already come back as JS numbers. Ids are 24-hex text; foreign keys hold the same strings.
- Child tables: product variants (`product_variants`) and shop order items (`shop_order_items`) are separate tables; the repos return the flat row, so rebuild `variants[]` / `items[]` in the product/order code. `shop_settings` is a single row with id `default`.
- Counters: use `getNextSequence(name)` from `src/utils/counter.js` (lead ports it; same signature).
- Mongo `Date` math and timezones: the process sets `TZ` in `src/config/timezone.js`; where the old code bucketed by day/month, use the same zone explicitly (`AT TIME ZONE 'Asia/Kolkata'`) and compare with the Mongo output.
- Text search that used `$text`/regex becomes `ILIKE` or the generated `search` tsvector columns on `blogs` / `products`.
- The old Mongo behavior "`updated_at` changes on every update" is automatic in the repos.

## Isolated test environment (use your own; do not touch others')
```
scripts/parity/env.sh up <name> <basePort>     # baseline Mongo server on basePort, new Postgres server on basePort+1
scripts/parity/env.sh restart <name>           # restart both after editing code
scripts/parity/env.sh reset <name>             # restore both databases to the pristine copy of production data
scripts/parity/env.sh down <name>              # clean up when finished
```
`up` prints `SRC_MONGO_URI=... DATABASE_URL=...` for your databases: export both in the shell where you run scripts. Logs are in `/Users/giridhar/Developer/hkm-vizag/.localdb/envs/<name>/`. The data is a copy of real production data (donors, donations); treat it as sensitive, do not print large dumps of personal data into your report.

Tokens: `scripts/parity/lib.mjs` has `sign({userId, role})` (JWT secret `local-test-jwt-secret`), `discover()` for sample ids, `call()`, `normalize()`, `diff()`. Internal API secret: header `x-internal-secret: local-internal-secret`. Razorpay webhook/verify secrets locally are `local-webhook-secret` / `local-razorpay-secret`.

### Verification you must do
1. **Reads**: `node scripts/parity/reads.mjs http://localhost:<base> http://localhost:<base+1> [pathSubstring]` compares baseline vs new for ~100 read endpoints (the 4th argument filters paths). "order-only differences" (same rows, ties in a different order) are acceptable only if the old order was genuinely unspecified; otherwise match it. Add more read cases to `scripts/parity/reads.mjs` for your endpoints if coverage is thin (additive edits only, keep them in a clearly marked block for your slice).
2. **Writes**: write `scripts/parity/writes-<slice>.mjs` that replays the same sequence of mutating requests (create/update/delete/status changes, error cases like missing fields, bad ids, auth failures) against the baseline and the new server, reading back after each step, comparing status codes and normalized bodies (mask generated ids and timestamps with a helper), and finally comparing the resulting database state of the touched tables/collections. Use `env.sh reset` between runs.
3. Check the server log of the new server for errors during your runs.
4. Run `node --check` on edited files and make sure the app still boots (`env.sh restart`).

## Final report (keep it under ~60 lines)
Files changed; endpoints/functions ported; every intentional deviation (including the "Fixes"); parity results (counts identical / remaining diffs and why); requests for the shared layer or schema (exact DDL); anything you could not verify and why.
