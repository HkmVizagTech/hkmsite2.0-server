# Final verification report (2026-10-15)

Local only. Branches: server `postgres-migration` (contains upstream `origin/main` 6fc96ca incl. the Prasadam dispatch module), client `chore/hardening` (contains upstream 1a7b66a). **Nothing pushed, `main` untouched in both repos.** Re-fetch `origin` and port anything new right before the production migration (the team keeps pushing).

Method: old build (upstream `origin/main`, MongoDB) and new build (Postgres) run side by side on copies of the same production data, with Razorpay/DCC/WhatsApp/Meta/DRM/R2/courier replaced by recording fakes; identical requests are sent to both; status, body, database state and the exact outbound requests to the outside services are compared, with `null` and "missing" treated as different.

## Results (final code)
| Check | Result |
|---|---|
| Every stored document, all tables, strict nulls | identical (all documents incl. variants and order items) |
| Reads (470 calls) | 462 identical; the 8 left are Mongo tie order (payment-failures, devotees) and 1 ms blog `updatedAt` |
| Shop writes | 147 steps, 0 differences (+ 5,167-step edge matrix, 35k fuzz variants) |
| Content/admin writes | 238/238 identical, 18/18 tables identical (+ ~210k fuzz requests) |
| Donations writes (incl. new Prasadam routes) | 349 steps identical, 0 differing, 3 intentional |
| Payment flows with mocked outside services | 20/20 scenarios identical incl. exact outbound requests to Razorpay, DCC, Flaxxa/Gupshup, Meta, DRM, R2, couriers (one scenario was flaky from test row timestamps; fixed, 5/5) |
| Role matrix, 216 routes x 10 identities | 2087/2120; the 12 differing routes are clock noise, tie order, or the intentional `POST /donations` change |
| Broad fuzz, all 216 routes (page/limit/search/filter extremes, regex chars, injection strings, unicode, wrong-typed/null/huge bodies, invalid JSON, bad ids) | 67,471 of 69,077 identical, 2,365 more identical apart from row order; the 10 route groups with differences are all explained below |
| Response headers (CORS, cache, security) | identical, 144 combinations |
| Client | production build passes (105 routes); 66 pages load clean on both stacks; 14 browser flows (contact form, admin login/donations/Prasadam tabs/blog editor/dashboard/shop, donor session, add to cart...) identical on Mongo stack, Postgres stack in Chromium and in Brave |

## Live client comparison (2026-10-15)
Our client (production build of branch `chore/hardening`) running locally against the Postgres server, loaded with a fresh copy of production data (9,995 donations), compared with `https://www.harekrishnavizag.org` (read-only visits): 39 pages (public pages plus a blog, event, festival and product detail page) x desktop and phone viewport = 78 checks. Same HTTP status 78/78; same page title and meta tags 78/78; same image, link and heading counts 78/78; every screenshot within 0.5% pixels (55 of 78 exactly 0%); no JavaScript errors on either side. Visible text identical on 70/78; the other 8 are live countdown timers a few seconds apart (6) and the festival detail date (2), which is a client-side time-zone effect (the live host renders in UTC; run locally with TZ=UTC the page is identical, and the API returns the same `eventDate` on both). Not compared against live: admin screens and anything that writes (needs real credentials and would change production data).

## Live admin comparison (2026-10-15, read-only: only GET requests plus the login; every other request blocked in the browser)
- Admin API: 62 admin/public GET endpoints called on the live production API and on our Postgres version with the same admin user: all 62 return the same status and the same structure; 50 are value-for-value identical to production; the other 12 differ only in array order from Mongo's arbitrary group order (stats, reports, devotees, payment failures), view counters/timestamps that visitors keep changing (blogs), and `dcc-status.configured` (true on live, false in the local test environment).
- Admin UI: 24 admin pages on live and on our local build, both logged in as the same admin: all 24 same size, 21 identical text, every screenshot within 2% (devotees 1.58%, others <=0.1%). The 3 text differences: blog view counter (297 vs 299, visitors/tests), and two orderings of tied rows (devotees, seva list). Tabs on the two donations admin pages (17 compared, one read-only live login, later the same day): 9 identical; the other 8 are fully explained: Overview, Payment failures, UTM Analytics and UTM Campaigns show the same rows with equal amounts/counts in a different order (Mongo tie order); the two DCC receipts tabs differ only because DCC is configured on live and not in the local test server; the two UTM Builder tabs show the site's own address (live domain vs localhost). The only requests blocked on live were Cloudflare analytics beacons (`/cdn-cgi/rum`), no application write was attempted.
- Relationships and data (`scripts/parity/relcheck.mjs`, fresh copy of production, 9,995 donations): every donation's id, donor, festival, manual-entry user, creator, Razorpay order id, payment id, subscription id, receipt number, DCC donor id, campaigner/festival slug, transaction id, UTR and WhatsApp message id are identical; total and per-status amounts identical; per-donor totals identical for all 6,790 donors with donations; all 6,793 donor ids, mobiles and DCC numbers identical; shop order, issue, campaigner, festival, registration and blog references identical; ID counters identical.

## Railway rehearsal (2026-10-15, real Railway Postgres 18.6, UTC, SSL, through the public TCP proxy)
Fresh Atlas copy (9,997 donations, 6,794 donors) migrated into the empty Railway database in 11 seconds (31 tables, no failed or unmappable documents). Verification against the Mongo copy: every document identical (strict nulls); counts, per-status sums, monthly totals, receipt numbers, counters, 200 sampled donations all pass; 33 relationship/amount checks identical (donor, festival, creator, manual-entry user, Razorpay order/payment/subscription ids, receipt numbers, per-donor totals). The new server (ES modules, SSL, 4-connection pool) run locally against the Railway database vs the old server on Mongo: 443 of 470 read checks identical; the 27 differences are blog view counters/timestamps (the fire-and-forget view increment lands at different times with network latency), and Mongo tie order (payment-failures, devotees). The public proxy reset connections when 15 opened at once (verification scripts); use PG_POOL_MAX=2-4 when working through the public address. From the API inside Railway (private network, `postgres.railway.internal`) this does not apply. The Railway database now holds this rehearsal copy; the API is NOT pointed at it. At cutover it is wiped and reloaded.

## Full local stack on the real Railway Postgres (2026-10-15)
Our client (running locally) + new server (running locally, SSL, 4-connection pool) on the Railway database, compared with the old stack (client + old Mongo server) on the same data: 14 browser flows (contact form, admin login/donations/Prasadam tabs/blog editor/dashboard/shop, donor session, add to cart, detail pages) in Chromium and Brave: identical results and identical API calls (one call is attributed to the next flow because of network latency, same call, same 200); 66 pages: 64 identical plus 2 known artifacts (the existing `/seva-stats/brick-campaign` 404 appears on both; the extra test contact message from the second browser pass). The temporary test data (admin password, product stock, contact messages) was then removed by re-running the migration with `--truncate`; the Railway database again matches production exactly: every document identical (strict nulls), counts/sums/receipts pass, 33 relationship checks identical.

## Decisions by the owner (2026-10-15)
- Protections stay on (they do not change behavior for normal use). The extra rate limits on `/payments/subscription` and `/payments/verify` were removed (not in the old code).
- Everything else must behave exactly like the old APIs.

## What the last fuzz differences are (all explained)
Timestamps 1-9 ms apart on records the test itself wrote (`PUT /users/update`, `GET /users/`, `PUT /donation-page/`, `PUT /site-content/`, `POST /temple-devotees/admin`, `send-pending-reminders` window); Mongo's arbitrary tie order (`/donations/payment-failures`, `/devotees` page boundaries); the blog view counter, which both builds increment fire-and-forget so the value seen depends on timing; `PUT /donations/:id` with a bad amount (intentional field whitelist).

## Natural order
Unsorted reads now return rows in the order MongoDB returned documents (insertion order) through a hidden `seq` column; this fixed `GET /preacher/search-donor`, which picked a different first donor because one donor record sits out of ID order in the real data.

## Intentional differences that remain (only for abusive or unusual input; normal flows are identical)
1. `POST /donations` requires an admin login (was open to anyone); no client calls it.
2. `PUT /donations/:id` and admin updates for events, galleries, important dates, volunteers, festival donations/showcases accept only the fields the admin forms send.
3. Blog `content` is sanitized on create/update (scripts, event handlers, `javascript:` URLs, non-YouTube/Vimeo iframes removed).
4. `/payments/verify`: the signed order must belong to the donation being verified (old code let a cheap payment complete a different, expensive donation); verify fields sent as arrays/objects get a 400 instead of being run as database operator queries.
5. Signature/secret comparisons are constant-time; OTPs use a secure random generator; preacher donor view no longer shows OTP hash fields; duplicate or overlapping webhook/reminder runs are race-safe (old code created duplicate donations, DCC pushes and WhatsApp sends); client `/api/revalidate` needs a staff login.

## Unavoidable differences
Mongo `$group`/tie order is arbitrary (varies even between two Mongo runs); NUL characters in strings; dates before 1900 by clock offset; a few exotic PCRE regex constructs.

## Not verifiable locally
Real Razorpay/DCC/WhatsApp/R2/courier behavior: tested only against fakes built from the code and from real stored DCC responses (DCC duplicate-donor handling and courier payload shapes are guesses). The first real donation after the production cutover is the final check.

## Next (needs the owner)
1. Create the Postgres service on Railway (same project and region as the API); connection string only into the environment.
2. Staging rehearsal: fresh Atlas dump -> `db:init` -> `db:migrate-from-mongo` -> `db:verify` -> run the same parity suites against staging.
3. Production cutover per `CUTOVER.md`, then end-to-end test on production data, then merge to `main`.
4. Resolve two duplicated receipt numbers (`HKMI|2026|D/VSP|10374`, `...|10267`) before adding a unique index.
5. Delete `/Users/giridhar/Developer/hkm-vizag/.localdb` when finished (real donor data).
