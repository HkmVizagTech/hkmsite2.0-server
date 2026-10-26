# Upstream changes ported to Postgres (2026-10-26)

Upstream `origin/main` (6f0deef) had 6 commits that the migration branch did not have. The branch records the merge
(`git merge -s ours`, so a later `git merge origin/main` only shows newer commits) and the changes were ported by
hand to the SQL layer. Nothing is pushed.

| Upstream commit | Ported as |
|---|---|
| 3750026 `/payments/verify` only completes its own donation | `verifyPayment` rewritten to the upstream rules: strings only, 400 "Invalid donation reference", order/subscription must belong to the donation ("This payment does not belong to this donation"), 409 "already recorded against another donation" (200 for a subscription charge the webhook already recorded) |
| 5a8b024 subscription.activated never overwrites a paid month | `activated` only touches a `pending` record with no payment id; `handleSubscriptionCharged` accepts an `active` sign-up record, strips the extra receipt/WhatsApp/DCC/Meta fields from the monthly clone and sets `transactionId`. The upstream unique index on `razorpayPaymentId` is NOT added: two completed donations already share a payment id. The advisory lock + `already_recorded` check inside the transaction cover the race |
| 2910dd9 / 5a8b024 Monthly Seva list | `GET /donations/subscriptions` (`subscriptionsAdmin.controller.js`), the Mongo `$group` as one SQL `GROUP BY` |
| 9a7adb5 event registration fee | `event_registrations` gets `payment_choice, amount, payment_status, razorpay_order_id, razorpay_payment_id, paid_at`; Razorpay order on `register`, `POST /events/:id/registrations/:regId/verify-payment`, `payment.captured` webhook marks the registration paid, check-in returns 402 while pending |
| 51b8681 events slug | `events.slug` (unique when set) and `events.previous_slugs`; `GET /events/:idOrSlug`, slug on create/update, `ensureEventSlugs` at boot, `src/utils/slug.js` |
| 55be194 DRM seva for DCC | `donations.dcc_seva_category / dcc_seva_sub_category / dcc_seva_sub_category_code`; only used when `DCC_USE_DRM_SEVA=true` (off by default) |

## Schema
`docs/postgres-migration/schema.sql` ends with an idempotent `-- ==== UPGRADES` section. `npm run db:init` creates the
schema on an empty database and, on a database that already has it, applies just that section, so the Railway
rehearsal database does not need a wipe. `scripts/migrate-mongo-to-pg.js` maps the new fields.

Also fixed: `product_variants` has no unique `id` any more, so the migration's `ON CONFLICT (id)` would have failed on
the first product with variants (production has none today). Variant fields set to an explicit `null` (and unknown
variant keys) are now kept in `product_variants.extra`, like the other tables.

## Verified (fresh copy of production, old Mongo build = upstream main, new Postgres build)
Old build = upstream `origin/main` (Mongo), new build = this branch (Postgres), both fed a fresh read-only copy of
production (10,184 donations, 6,886 donors), Razorpay/DCC/WhatsApp/Meta/DRM/R2 replaced by recording fakes.

| Check | Result |
|---|---|
| `db:verify` (counts, sums, receipt numbers, counters, 200 sampled donations) | all pass |
| Every stored document round-trips (`shapes.mjs`), 33 relationship checks (`relcheck.mjs`) | identical |
| Reads (470) | 464 identical; the 6 left are Mongo tie order (payment-failures) and a 1 ms blog view-counter timestamp |
| Role matrix, 216 routes x 10 identities | 2087/2120 (rest: clock noise, tie order, `POST /donations` is public again, as in production) |
| New: events slug, registration fee + verify-payment + webhook + check-in 402, Monthly Seva list (9 filter combos), `/payments/verify` edge cases (`writes-upstream.mjs`) | 73/73 identical |
| DRM seva for DCC with `DCC_USE_DRM_SEVA=true` (`writes-dcc-seva.mjs`) | identical DCC requests |
| Content/admin writes | 238/238 steps, 18/18 tables identical |
| Donations writes | 349 identical, 3 intentional differences |
| Shop writes / edge matrix | 147 steps 0 differences / 5167 steps, 3 differ (test fixture rows inserted without `variantId`) |
| Payment flows with fakes (20 scenarios) | 18 identical; 2 depend on timing in both builds (see below) |
| Browser (Chromium): one-time donation, monthly seva, paid event registration by slug through a stubbed Razorpay checkout, old event id URL redirect, admin donations + Monthly Seva tab | same requests, statuses and UI on both stacks |

The two payment scenarios that differ in a full run both pass when run on their own: `concurrency` (Meta CAPI purchase
is "check, then send" in the old code too, so the number of events from 5 simultaneous pipelines depends on timing) and
`pending reminders` (the count of donations inside the reminder window depends on earlier scenarios).

## Cutover additions
- Run `npm run db:init` before `db:migrate-from-mongo` (it now also applies the upgrades).
- `DCC_USE_DRM_SEVA` stays unset/false unless DRM is meant to choose the seva.
