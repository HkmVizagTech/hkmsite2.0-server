# Migration status (read this first)

Updated 2026-10-14. Everything below is local: branches `postgres-migration` (server) and `chore/hardening` (client). Nothing is pushed, `main` is untouched in both repos, production is untouched.

## Done and verified (old Mongo build vs new Postgres build, on a copy of production data)
- Data: every stored document in all tables round-trips identically, including explicit nulls, unknown legacy fields, and product variants / order items (`scripts/parity/shapes.mjs`).
- Content/admin routes: about 210k differential requests, no unexplained differences. Shop routes: 35k+ requests, none. Payments: full flows through mocked outside services, identical outbound requests and rows (16 of 20 scenarios; the other 4 explained in the agent report: a race fix, a cascade of it, a null-field item now fixed, a full-run-only reminder count).
- Reads: 296 of 304 identical; the 8 left are Mongo tie-order and 1 ms blog timestamps.
- Role matrix: who can do what is identical on every route (the only difference: `POST /donations` is now admin-only, on purpose).
- Response headers identical (CORS, caching, security headers). Client production build passes. Browser tests (Chromium and Brave): 13 flows identical.

## Still running
- Donations/reporting/donor-pages equivalence pass (last helper). After it reports: one final full verification run, then a single list of remaining differences (intentional vs unavoidable) in `FINAL_REPORT.md`.

## Intentional differences (security fixes, kept on purpose)
- Payment verify checks the signed order belongs to that donation (old code let a cheap payment complete an expensive donation).
- `POST /donations` admin-only; admin update endpoints whitelist fields; blog HTML sanitized on save; constant-time secret checks; OTP via crypto.randomInt; rate limits on `/payments/subscription` and `/payments/verify`; preacher donor view no longer includes OTP hashes; client `/api/revalidate` requires staff login.

## Unavoidable
- Mongo returns tied rows in arbitrary order (not reproducible even on Mongo itself); NUL characters in strings; a few exotic regex constructs.

## Before production
1. Staging rehearsal on Railway Postgres with a fresh Atlas dump, then `CUTOVER.md`.
2. The temple should resolve two duplicated receipt numbers before a unique index is added.
3. Delete `/Users/giridhar/Developer/hkm-vizag/.localdb` afterwards (contains real donor data).
