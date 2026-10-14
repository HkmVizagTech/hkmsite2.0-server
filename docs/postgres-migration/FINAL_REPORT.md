# Final verification report (2026-10-14, ~18:55)

All local; branches `postgres-migration` (server) and `chore/hardening` (client); nothing pushed; `main` untouched; production untouched.
Method: old build (Mongo, branch main, worktree) and new build (Postgres) run side by side on copies of the same production data; identical requests sent to both; status, body and database state compared with `null` and "missing" treated as different.

## Result of the last full run (code at commit after b04688b)
| Check | Result |
|---|---|
| Every stored document, all tables, strict nulls | identical (17k+ documents incl. variants/order items) |
| Reads (304 endpoint calls) | 303/311 identical in the last run; the rest are Mongo tie-order (payment-failures, devotees) and 1 ms blog timestamps |
| Shop writes | 147 steps, 0 differences (plus 5,167-step edge matrix, 35k fuzz variants, earlier) |
| Content writes | 238/238 identical, 18/18 tables identical (plus ~210k fuzz requests, earlier) |
| Donations writes | 257 steps identical, 3 intentional, **9 differing: see open items** |
| Payments | helper ran 16/20 full-flow scenarios identical incl. exact outbound requests (earlier); not re-run in this last pass |
| Role/route matrix 213 routes x 10 identities | 2057/2090; all 12 differing routes are timestamp noise, tie order, or the intentional `POST /donations` change |
| Response headers (CORS, cache, security) | identical, 144 combinations |
| Client production build | passes; browser flows (Chromium + Brave) identical |

## Open items (not yet closed)
1. Donations write suite, 9 steps (after `dcc-status`, `needs-manual-receipt`, `needs-whatsapp` counts differ by 1; and shape differences on a donation created directly by the test fixture: `type`, `certificate`, `prasadamAddress.country`, `utm`). Probably test-fixture rows (created raw in Mongo and by SQL in Postgres) rather than product behavior, but not proven. Next step: run `scripts/parity/writes-donations.mjs` on a fresh env and compare the fixture rows' defaults and the three admin counts.
2. Re-run the payment flow proof on the final code: `MOCKS=1 scripts/parity/env.sh reset eq-payments` then `node scripts/parity/writes-payments-flows.mjs` (the older `writes-payments.mjs` is stale: it compares mock counters and now flags strict nulls).
3. Donations helper's last edits (Invalid Date handling in aggregates, devoteeId cast) were never re-run; non-quick `/donations` fuzz never completed.
4. A prasadam-status fix made at the very end (old code unset fields; new code wrote null) is verified only by the donations suite (it removed 9 failures).
5. Success paths needing real outside services were exercised only through mocks: DCC duplicate-donor handling and courier payload shapes are guesses.

## Intentional differences
Admin-only `POST /donations` and whitelisted `PUT /donations/:id`; admin update whitelists (event, gallery, importantDate, volunteer, festival donation/showcase); blog HTML sanitization on save; payment verify binds signed order to donation; constant-time secret/signature checks; `crypto.randomInt` OTP; rate limits on `/payments/subscription` and `/payments/verify`; no OTP hash in preacher donor view; duplicate/overlapping `subscription.charged` and reminder passes are race-safe (old code created duplicates); client `/api/revalidate` needs staff login.

## Unavoidable
Mongo `$group`/tie order is arbitrary (varies on Mongo itself); NUL characters in strings; dates before 1900; a few exotic PCRE regex constructs.

## Production steps (unchanged)
Staging rehearsal on Railway Postgres, then `CUTOVER.md`. Two receipt numbers are duplicated in the data (`HKMI|2026|D/VSP|10374`, `...|10267`): resolve before adding a unique index. Delete `/Users/giridhar/Developer/hkm-vizag/.localdb` when finished (real donor data).
