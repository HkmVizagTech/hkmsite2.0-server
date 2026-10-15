# Production cutover runbook (MongoDB Atlas -> Railway Postgres)

State: Railway Postgres service created in the production project, public TCP proxy on for the migration, schema created and rehearsed with a fresh copy (see FINAL_REPORT.md). The API service still runs the old Mongo build and is not connected to Postgres.

## Before the day
1. Postgres service -> Backups tab: turn on scheduled backups. Optionally schedule a `pg_dump` to R2.
2. Decide the build to deploy: the branch `postgres-migration` must be on GitHub for Railway to build it. Pushing a branch other than `main` does not change production. Recommended: API service -> Settings -> Source -> Branch: switch from `main` to `postgres-migration` only at cutover, and switch back if rolling back. Merge into `main` only after the production test below passes.
3. Re-fetch upstream (`git fetch`), port anything new pushed to `main`, re-run `FINAL_RUN` checks.
4. Prepare the API variables (do not set yet): `DATABASE_URL` = reference `${{Postgres.DATABASE_URL}}` (private network). Keep `MONGO_URI` and every other variable as they are (Mongo stays untouched for rollback). Check `PORT` is left to Railway.
5. Choose a quiet hour. Expected downtime: a few minutes.

## Cutover
1. Stop writes: API service -> Deployments -> remove/stop the running deployment (or scale to zero). Razorpay retries webhooks for about 24 h, so webhooks arriving during the pause are redelivered; WhatsApp/DCC steps resume afterwards.
2. From the laptop (public proxy URL, `PGSSL=true`, `PG_POOL_MAX=2`): `SRC_MONGO_URI=<atlas uri> DEST_PG_URL=<railway public url> node scripts/migrate-mongo-to-pg.js --truncate` (takes about 15 seconds; a full reload, not a delta, so rows changed since the rehearsal are correct).
3. `npm run db:verify` and `node scripts/parity/shapes.mjs` and `node scripts/parity/relcheck.mjs` with the same variables (REL_MONGO / REL_PG for relcheck). All must pass.
4. Set the API variable `DATABASE_URL`, switch the source branch to `postgres-migration`, and deploy. The API starts on Postgres; the boot seeders are idempotent.
5. Smoke test: `/health` (db connected), home page, a donation page, admin login, admin donations list and Prasadam tabs, then one low-value real donation end to end (order, payment, webhook, DCC receipt number, WhatsApp receipt). Compare the live site against the earlier read-only comparison scripts (`scripts/parity/live-api.mjs` needs the admin login; `pages.mjs`).
5b. **Real payment test (owner decision 2026-10-15: after the cutover, on production, new code).** The owner makes the donation in a normal browser and approves it in PhonePe; nobody automates the payment. Minimum amount is Rs.100 (the server rejects less; to test Rs.1 the owner must approve setting `MIN_DONATION_AMOUNT=1` on the API service for the duration of the test and removing it afterwards). Use the owner's own phone number so the WhatsApp receipt arrives there; try the number once with `+91 98765 43210`-style input. Check, through the Railway database and the read-only admin API: donation `completed`; `razorpay_order_id` and `razorpay_payment_id` set and matching the Razorpay dashboard; webhook received (Razorpay dashboard shows 200); DCC receipt number present and `dcc_sync_status = synced` (DCC shows the donor and donation); WhatsApp receipt delivered (`whatsapp_delivery_status` = delivered/read); Meta purchase event sent; DRM sees the donor; the donor can log in with OTP and see the donation in the donor dashboard; the 80G receipt PDF downloads. If anything fails, roll back (see Rollback) and investigate with the logs. Do not repeat live payments beyond one or two small tests.
6. Turn off the Postgres public access (Settings -> Networking -> remove the TCP proxy) once the API is verified on the private address.
7. Merge `postgres-migration` into `main` (server) and `chore/hardening` into `main`/`dev` (client) following your branch workflow, then switch the Railway source branch back to `main`.

## Rollback
- Switch the API source branch back to `main` and remove (or unset) `DATABASE_URL`; redeploy. Atlas is untouched, so it is complete up to the freeze in step 1. Donations taken on Postgres after the cutover would be missing there: export them (`donations` where `created_at > <cutover time>`) and re-enter or script them.
- Keep Atlas read-only for several weeks and do not delete it until Postgres backups are proven.

## After
- Monitor Railway Postgres disk and memory. `PG_POOL_MAX` defaults to 15 per API instance.
- `mongoose` and `mongodb` are dev dependencies used only by the migration and parity tools.
- Resolve the two duplicated receipt numbers before adding a unique index.
- Delete `/Users/giridhar/Developer/hkm-vizag/.localdb` (it holds copies of real donor data and the Railway connection string) and change the admin password that was shared in the chat.
