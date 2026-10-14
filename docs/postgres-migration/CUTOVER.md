# Production cutover runbook (MongoDB Atlas -> Railway Postgres)

Not executed yet. Everything below was rehearsed locally against a copy of production data; the real run needs an explicit go-ahead.

## Before the day
1. Railway: add a Postgres service to the same project and region as the API (private networking, `DATABASE_URL` referenced from the API service). Turn on volume backups and schedule `pg_dump` to R2.
2. Rehearse on a **staging** Railway Postgres with a fresh Atlas dump: `npm run db:init`, `npm run db:migrate-from-mongo`, `npm run db:verify`, then run the parity harness against a staging build. Time each step.
3. Decide the two known data issues: two donations share a receipt number (`HKMI|2026|D/VSP|10374`, `...|10267`) and two reference deleted festivals. The unique index on `receipt_number` (commented in schema.sql) can only be enabled once the duplicates are resolved.
4. Deploy-ready build: branch `postgres-migration`, Node 22, env vars from `.env.example` (`DATABASE_URL` new, `MONGO_URI` no longer used).

## Cutover (target: a few minutes, quiet hour)
The data set is small (about 22 MB), so the final sync is a full reload rather than a delta: re-running the migration without `--truncate` only adds new documents and would leave rows that changed in Mongo (for example a pending donation completed since the first copy) stale.
1. Stop writes: scale the current API to zero (or put it in maintenance). Razorpay retries webhooks for about 24 h, so webhooks received during the pause are redelivered.
2. `npm run db:init` (first time only).
3. `SRC_MONGO_URI=<atlas> DEST_PG_URL=<railway public url> node scripts/migrate-mongo-to-pg.js --truncate`
4. `npm run db:verify` with the same variables. Every check must pass (counts, per-status sums, monthly totals, receipt numbers, counters, sampled documents).
5. Deploy the new build with `DATABASE_URL` set. Boot seeders are idempotent.
6. Smoke test: `/health`, home page, a donation page, `/donor-auth/send-otp` flow, admin login and donations list, one low-value live donation end to end (order, pay, webhook, receipt number, WhatsApp).
7. Re-enable jobs if they were paused (reconcile, DCC sweep, reminders, tracking).

## Rollback
- Within the first hours: redeploy the previous build (branch `main`, Mongo). Atlas is untouched and only frozen at step 1, so it is complete up to the freeze. Donations taken on Postgres after the cutover would be missing there; export them (`donations` where `created_at > <cutover time>`) and re-enter or script them.
- Keep Atlas read-only for several weeks and do not delete it until the Postgres backups are proven.

## After
- Monitor Railway Postgres disk and memory; keep `PG_POOL_MAX` at 10-20 per instance.
- `mongoose` and `mongodb` remain dev dependencies only for `scripts/migrate-mongo-to-pg.js`, `scripts/verify-mongo-pg.js` and `scripts/parity/`. Remove them once those are no longer needed.
