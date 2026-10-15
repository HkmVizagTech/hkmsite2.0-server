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
| Response headers (CORS, cache, security) | identical, 144 combinations |
| Client | production build passes (105 routes); 66 pages load clean on both stacks; 14 browser flows (contact form, admin login/donations/Prasadam tabs/blog editor/dashboard/shop, donor session, add to cart...) identical on Mongo stack, Postgres stack in Chromium and in Brave |

## Decisions by the owner (2026-10-15)
- Protections stay on (they do not change behavior for normal use). The extra rate limits on `/payments/subscription` and `/payments/verify` were removed (not in the old code).
- Everything else must behave exactly like the old APIs.

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
