# MongoDB → Railway Postgres migration plan

Status: phase 0 (analysis). Nothing in the running app has been changed.
Files here: `schema.sql` (draft schema, 25 models → 30 tables).

## Scope found in the code
- 25 Mongoose models (+ raw `bootstrap_runs` collection, + `counters`).
- ~370 inline model calls across controllers/services; no repository layer.
- 57 `aggregate()` calls (inventory below) — 53 of them on `donations`.
- 3 text indexes (blogs, products, media) → Postgres FTS / trigram.
- 2 transaction uses (darshan sync).
- Mongoose pre-save hook on blogs (read_time, published_at) must move into code.
- Atomic `$inc` counters (donor ids) → `counters` upsert, or a sequence.

## Key schema decisions (see schema.sql)
| Mongo | Postgres |
|---|---|
| `_id` ObjectId | `id bigint identity` + `legacy_id text unique` (kept for DRM/DCC/Razorpay/WhatsApp cross-refs) |
| `ref` fields | real foreign keys (migrated via legacy_id lookup) |
| Number money | `numeric(12,2)` |
| nested `utm`, `prasadamAddress`, `upiFallback`, `paymentError` on donation | flattened columns (they are filtered/grouped/indexed) |
| `dccPayload`, `dccResponse`, registration `data`, `meta`, site/page CMS blocks | `jsonb` |
| product `variants[]` | `product_variants` table (shop order items reference variant id) |
| shop order `items[]` | `shop_order_items` table |
| order `statusHistory`, `stockShortfall` | `jsonb` (append-only logs) |
| string arrays (images, tags) | `text[]` |
| enums | `text` + CHECK |
| text indexes | generated `tsvector` + GIN (blogs, products); trigram (media) |

New integrity guards (Mongo had none; add after data is verified clean):
unique `receipt_number`, unique `razorpay_payment_id` (non-recurring).

## Aggregation inventory (to port to SQL)
| File | Count | Purpose |
|---|---|---|
| donation.controller.js | 18 | stats, by-source-page, UTM stats/transactions, reports, whatsapp audit, prasadam, subscriptions audit |
| donationAdmin.controller.js | 10 | /donations admin totals, per-seva, DCC status, reports |
| dashboard.controller.js | 7 | monthly / daily / per-seva / status dashboards |
| sevaStats.controller.js | 4 | public seva + sqft campaign totals |
| preacher.controller.js | 3 | preacher rollups |
| paymentFailures.controller.js | 3 | failure reasons / methods |
| donor.controller.js | 3 | donor totals and history |
| campaigner.controller.js | 2 | campaigner raised amounts |
| blog.controller.js | 2 | category counts |
| upiFallback / shopOrder / product / devotee / backfill script | 1 each | counts and rollups |
Most are `$match → $group (sum/count) → $sort`: straightforward `GROUP BY`.
Complex ones (date bucketing, conditional sums) still need line-by-line review; no `$lookup` is used anywhere.

## Phases
0. **Analysis** (this folder) — done once schema/decisions are approved.
1. **Provision**: Railway project with *staging* Postgres first; same project/region as the server; internal `DATABASE_URL` for the server, public URL only for running the migration from a laptop.
2. **Data layer**: add Prisma or Drizzle; introduce repositories per domain (donations last). Behaviour unchanged, Mongo still the source.
3. **Migration script** `scripts/migrate-mongo-to-pg.js`: per table, in FK order (users → donors → events/festivals → campaigners → donations → shop → content), batched, idempotent via `legacy_id`, prints row counts and sums.
4. **Verification**: row counts per table; `SUM(amount)` by month/status; counts of receipt numbers, payment ids, donors; spot-check 50 random donations field-by-field; compare outputs of every ported aggregation against Mongo on the same data.
5. **Port queries** domain by domain behind a feature flag (`DB_BACKEND=mongo|pg`), shop/content first, payments last.
6. **Cutover**: short write freeze (payments are the concern — webhooks keep arriving; Razorpay retries, but pause jobs: reconcile, DCC sweep, tracking, reminders), run final delta migration, flip flag, unpause. Keep Mongo read-only for several weeks.
7. **Backups**: Railway volume backup + scheduled `pg_dump` to R2.

## Open decisions
1. ORM: Prisma (recommended) vs Drizzle.
2. Keep `legacy_id` permanently? (Recommended: yes until DRM/DCC cross-refs are confirmed independent of it.)
3. Maintenance window length acceptable for cutover (recommend 15–30 min at a quiet hour).
4. Is the DRM (separate repo) reading Mongo directly, or only via `/api/internal/drm`? If directly, it also needs migrating — please check.
5. Does anything else read this Mongo (analytics, Metabase, scripts)?
6. Mongo is on Atlas? Confirm so we can take a snapshot before starting.

## Findings from the real-data restore (local, Oct 2026)
- Collections restored from Atlas db `test`: donations 9,987 · donors 6,790 · blogs 40 · media 100 · users 12 · shoporders 2 · products 3 · others small.
- `paymentdowntimes` (inline model in paymentFailure.service.js, 30-day TTL) was missing from the first schema → table added; TTL replaced by a periodic DELETE job.
- `ekadashicampaigns` is an orphan collection (controller serves hard-coded defaults) → not migrated.
- Models can live outside `src/models`; always cross-check against the actual collection list.
- Local test setup: Mongo on :27018 (`.localdb/mongo-data`), Postgres on :5433 db `hkm_local` (`.localdb`), both outside the git repos.

## Progress log
- **Phase 3 + 4 done locally (data only).** `scripts/migrate-mongo-to-pg.js` migrated the full Atlas copy (31 tables, ~18k rows, 9,987 donations) with zero failures; `scripts/verify-mongo-pg.js` passes all checks (counts, per-status sums, 6 monthly completed buckets, receipt/payment counts, counters, 200-donation random field compare incl. DCC JSON).
- **Real-data issues found (exist in Mongo today, not caused by migration):**
  1. Two receipt numbers are shared by two donations each (`HKMI|2026|D/VSP|10374`, `…|10267`). The planned unique index on `receipt_number` cannot be enabled until these are resolved by the temple.
  2. Two donations reference festival records that no longer exist → `festival_id` set NULL (the `festival_slug` text is kept).
- **Not done yet:** Phase 2/5 — the application code still talks to Mongo. Next: port the app's queries to `pg` behind `DB_BACKEND=mongo|pg`, domain by domain, then compare API responses between the two backends.
