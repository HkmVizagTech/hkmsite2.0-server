# hkmsite2.0-server

Express 5 API for the Hare Krishna Movement Vizag website: donations and payments (Razorpay), receipts (DCC + WhatsApp), temple shop, blogs/events/gallery CMS, donor portal and the DRM internal API. Data lives in PostgreSQL.

## Run locally
```bash
npm install
cp .env.example .env          # fill in values
npm run db:init               # creates the schema on an empty database
npm run dev
```
Requires Node 22+ and PostgreSQL 14+.

## Database
- `docs/postgres-migration/schema.sql` is the schema. Every table's `id` is a 24-hex text id (ObjectId format), foreign keys hold the same strings.
- `src/db/pg.js` is the connection pool and helpers (`query`, `one`, `many`, `tx`, `newId`).
- `src/db/table.js` + `src/db/tables.js` are small repositories with Mongo-style filters; aggregations and joins are plain SQL.

## Environment
Required: `DATABASE_URL`, `JWT_SECRET`, `INTERNAL_SECRET`. Optional integrations are skipped when their keys are missing: Razorpay (`RAZORPAY_*`), DCC (`DCC_*`), Gupshup (`GUPSHUP_*`), Meta CAPI (`META_*`), R2 (`R2_*`), Cloudinary, DRM (`DRM_*`).
Job switches: `RECONCILE_ENABLED`, `DCC_SWEEP_ENABLED`, `TRACKING_SYNC_ENABLED`, `PENDING_REMINDER_ENABLED` (each `false` to disable).
`ENV_FILE=/path/to/file` loads a different env file; use it for any test run so the real `.env` is never read.
Other: `PG_POOL_MAX` (default 15), `PGSSL=true` to force TLS.

## Migrating from MongoDB
`scripts/migrate-mongo-to-pg.js` copies a MongoDB database into Postgres (re-runnable, ids preserved) and `scripts/verify-mongo-pg.js` compares both. `scripts/parity/` holds the harness that replays identical requests against a MongoDB build and this build and diffs the responses. `mongoose` and `mongodb` are dev dependencies used only by those tools.
