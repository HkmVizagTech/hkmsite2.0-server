// node --import ./preload.mjs selftest.mjs : exercises each fake with the real client libraries.
import assert from "node:assert/strict";
import Razorpay from "razorpay";
import axios from "axios";
import FormData from "form-data";
import sharp from "sharp";
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const rz = new Razorpay({ key_id: "rzp_test_x", key_secret: "s" });
const order = await rz.orders.create({ amount: 5000, currency: "INR", receipt: "r1", notes: { a: "b" } });
assert.match(order.id, /^order_Mock/);
assert.deepEqual((await rz.orders.fetchPayments(order.id)).items, []);
const plan = await rz.plans.create({ period: "monthly", interval: 1, item: { name: "x", amount: 100, currency: "INR" } });
const sub = await rz.subscriptions.create({ plan_id: plan.id, total_count: 12 });
assert.equal((await rz.subscriptions.fetch(sub.id)).status, "created");
assert.equal((await rz.subscriptions.cancel(sub.id, false)).status, "cancelled");
assert.equal((await rz.qrCode.fetchAllPayments("qr_x", { from: 1, to: 2, count: 100, skip: 0 })).items.length, 0);
await assert.rejects(rz.payments.fetch("pay_nope"));

const s3 = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID || "acct"}.r2.cloudflarestorage.com`, credentials: { accessKeyId: "a", secretAccessKey: "b" } });
const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).jpeg().toBuffer();
await s3.send(new PutObjectCommand({ Bucket: "mock-bucket", Key: "media/t.jpg", Body: jpeg, ContentType: "image/jpeg" }));
assert.equal((await s3.send(new HeadObjectCommand({ Bucket: "mock-bucket", Key: "media/t.jpg" }))).ContentLength, jpeg.length);
await s3.send(new DeleteObjectCommand({ Bucket: "mock-bucket", Key: "media/t.jpg" }));

const img = Buffer.from(await (await fetch("https://pub-x.r2.dev/media-library/a.webp")).arrayBuffer());
assert.equal((await sharp(img).metadata()).format, "webp");
const dcc = await (await fetch("https://vhkmsurabhi.com/api/socialmedia/addDonation", { method: "POST", headers: { "content-type": "application/json", "DCC-Api-Key": "k" }, body: JSON.stringify({ gatewayPaymentId: "pay_1" }) })).json();
assert.match(dcc.ReceiptNumber, /^HKMI\|2026\|D\/VSP\|/);
const form = new FormData();
form.append("token", "secret-token");
form.append("header_attachment", jpeg, { filename: "a.jpg", contentType: "image/jpeg" });
assert.ok((await axios.post("https://wapi.flaxxa.com/api/v1/sendtemplatemessage_withattachment", form, { headers: form.getHeaders() })).data.message_wamid);
assert.equal((await axios.get("https://track.delhivery.com/api/v1/packages/json/?waybill=W1")).data.DeliveryData[0].Status, "In Transit");
assert.equal((await axios.get("https://trackapi.thirdutc.com/api/consignment?cnno=D1")).data.consignmentStatus, "In Transit");
assert.match((await axios.post("https://netconnect.bluedart.com/ShippingApi1.2/Tracking/RouteXML", { data: { WaybillNums: [{ WaybillNo: "B1" }] } })).data, /<Status>In Transit<\/Status>/);
assert.equal((await axios.get("https://clsapi.indiapost.gov.in/TrackConsignmentSimpleServlet?cnno=I1")).data.TrackConsignmentTrackDetails.TrackDetail[0].EventDescription, "In Transit");
assert.equal((await fetch("https://graph.facebook.com/v21.0/1/events?access_token=t", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [{}] }) })).status, 200);
assert.equal((await fetch("https://drm.mock.test/api/webhooks/hkmv/donor-updated", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
await assert.rejects(fetch("https://localhost.evil.test:1/"));
console.log("selftest ok");
