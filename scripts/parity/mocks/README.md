# Outbound service fakes

`nock` (via `node --import preload.mjs`) intercepts every outbound HTTP(S) call from fetch/undici, axios and `node:http(s)` (Razorpay SDK, AWS S3 SDK), in both the CommonJS baseline and the ESM server. Network is disabled except localhost/127.0.0.1, so nothing can leak. Each call is answered by a fake and appended to a JSONL log.

## Use
```
MOCKS=1 scripts/parity/env.sh up mocks 9900        # also: restart / reset (pass MOCKS=1 each time; up/reset wipe mock state + logs)
node scripts/parity/mocks/smoke.mjs mocks 9900      # proof: donation + webhook + DCC + WhatsApp, OTP, R2 upload, DCC outage
```
Per server (`baseline` / `new`) the env dir holds `<tag>-mock-state.json` (your script, `MOCK_STATE`), `<tag>-mock-state.store.json` (mock-owned counters and created entities), `<tag>-outbound.jsonl` (`MOCK_LOG`).
`MOCKS=1` also sets fake DCC_*, WAPI_TOKEN, GUPSHUP_*, META_*, R2_*, DRM_*, courier, CLOUDINARY_* values; `RECEIPT_WHATSAPP_PROVIDER` defaults to gupshup (pages listed in RECEIPT_FLAXXA_SOURCE_PAGES, default `donations`, use Flaxxa). Jobs stay off.

```js
import { setState, payOrder, failNext, readLog, clearLog, resetMocks, compareLogs, signWebhook, waitFor } from "./ctl.mjs";
resetMocks("mocks");                                   // empty state, ids restart, logs cleared (both servers)
payOrder("mocks", "both", orderId, { id: "pay_1" });   // order is now paid by pay_1
setState("mocks", "new", { dcc: { failNext: 2 } });    // patch is deep-merged; null deletes a key
const { equal, report } = compareLogs(readLog("mocks", "baseline"), readLog("mocks", "new"));
```
Comparison masks 24-hex ids (numbered by first appearance), ISO timestamps, 13-digit epochs, `receipt_<ms>`, `event_time`, OTP digits, multipart boundaries and file hashes (`{strictBytes:true}` keeps hashes). Order is enforced within a service only.

## State keys (all optional; default = everything succeeds)
Any service: `{ failNext: N | failAll: true, status, body, networkError }`. Services: `razorpay dcc flaxxa gupshup meta drm r2 r2public delhivery dtdc bluedart indiapost site cloudinary`.
- `razorpay.orderPayments[orderId] = [{id, status, amount, method, ...}]`, `defaultOrderPayments`, `payments[payId]` (payments.fetch), `captureFail:{status,description}`, `qrPayments[]`, `allPayments[]`, `subscriptions[subId] = {status, paid_count, ...}`, `invoices[subId] = [{id,status,payment_id,amount,date}]`, `orders[id]`, `plans[id]`. Unknown order/payment ids return Razorpay's 400 error.
- `dcc.existingDonorNumber` (IsNewDonor=false), `dcc.duplicate` = `recover` (default: same receipt + "already exists" message) | `error` ("Transaction details exist", no receipt) | `create`.
- `flaxxa.nullWamid` (Meta rejection), `gupshup.rejected`.
- `couriers.default` (initially "In Transit"), `couriers.byTracking[awb] = "Delivered"`.
- `r2.missing[]` keys that 404 on HEAD/GET.

## What is faked
| Dependency | Host | Fake |
|---|---|---|
| Razorpay SDK | api.razorpay.com | orders create/fetch/fetchPayments, payments fetch/all/capture, qr_codes payments, plans create/fetch, subscriptions create/fetch/all/cancel, invoices all. Ids `order_Mock00000001`, `plan_Mock...`, `sub_Mock...` |
| DCC | DCC_API_URL / vhkmsurabhi.com | addDonation -> `HKMI\|2026\|D/VSP\|900N`, `DonorNumber D9000N`, real response shape |
| Flaxxa WhatsApp | wapi.flaxxa.com | sendtemplatemessage, sendmessage, sendtemplatemessage_withattachment (multipart) -> `message_wamid` |
| Gupshup | api.gupshup.io (+ *.gupshup.io media) | template/msg -> `{status:"submitted", messageId}` |
| Meta CAPI | graph.facebook.com | events -> events_received |
| DRM | DRM_API_URL (https://drm.mock.test) | donor-updated 200 |
| R2 (S3 API) | *.r2.cloudflarestorage.com | PutObject/DeleteObject/HeadObject/GetObject, objects remembered |
| R2 public / images | R2_PUBLIC_URL host, *.r2.dev, any other image GET | 16x16 JPEG/WebP/PNG or tiny PDF by extension; HEAD on own public host true only for uploaded keys |
| Couriers | track.delhivery.com, trackapi.thirdutc.com (DTDC), netconnect.bluedart.com, clsapi.indiapost.gov.in | status payloads in the shape tracking.service parses |
| Site og:image | *.harekrishnavizag.org | HTML with og:image |
| Cloudinary | api.cloudinary.com | upload/destroy (code path currently unused) |
Anything else is answered 404 and logged with `"unmocked": true`.

## Log line
`{ts, service, method, host, path, query, headers (allowlist; secrets as "<set>", Razorpay basic auth as "basic:<keyId>"), body (JSON | form | {multipart:{fields,files:[{field,filename,contentType,size,sha256}]}} | {bytes,sha256}), response:{status}}`. Fields named token/access_token/apikey/password are redacted. Phone numbers and OTP codes are NOT redacted (local use only; the OTP is there so tests can log in).

`selftest.mjs` exercises each fake with the real client libraries: `node --import ./preload.mjs selftest.mjs`.
