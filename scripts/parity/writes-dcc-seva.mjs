import { MongoClient } from "mongodb";
import { sign, call, diff, normalize } from "./lib.mjs";
import { readLog, compareLogs, clearLog, resetMocks } from "./mocks/ctl.mjs";
const m = new MongoClient("mongodb://127.0.0.1:27018/m_e2e"); await m.connect(); const db = m.db();
const admin = await db.collection("users").findOne({ role: "admin" }); const tok = sign({ userId: String(admin._id), role: "admin" });
resetMocks("e2e");
const cases = [
  ["picked seva (numbers)", { dccSevaCategory: 3, dccSevaSubCategory: 5, dccSevaSubCategoryCode: 1 }],
  ["picked seva (strings + code text)", { dccSevaCategory: "2", dccSevaSubCategory: "103", dccSevaSubCategoryCode: "BSC" }],
  ["malformed seva -> old guess", { dccSevaCategory: "x", dccSevaSubCategory: 5, dccSevaSubCategoryCode: "<b>" }],
  ["no seva -> old guess", {}],
];
let i = 0, fails = 0;
for (const [name, extra] of cases) {
  i++;
  const body = { donorName: "Seva Test " + i, donorMobile: "90000000" + String(10 + i), amount: 100 + i, type: "Deepotsava - Annadana Seva", sevaName: "Deepotsava - Annadana Seva", utrNumber: "UTRSEVA" + i, manualPaymentMode: "cash", ...extra };
  const ra = await call("http://localhost:9100", { method: "POST", path: "/donations/manual", body, token: tok });
  const rb = await call("http://localhost:9101", { method: "POST", path: "/donations/manual", body, token: tok });
  const clean = (r) => normalize(JSON.parse(JSON.stringify(r.data, (k, v) => (["_id", "createdAt", "updatedAt", "date", "donorRecordId", "donorId", "receiptGeneratedAt", "dccSyncedAt", "dccLastAttemptAt", "lastPaymentDate", "whatsappReceiptSentAt", "whatsappThankYouSentAt", "metaPurchaseSentAt"].includes(k) ? undefined : v))));
  const d = diff(clean(ra), clean(rb));
  const seva = (r) => ({ c: r.data?.donation?.dccSevaCategory, s: r.data?.donation?.dccSevaSubCategory, k: r.data?.donation?.dccSevaSubCategoryCode });
  console.log(d.length || ra.status !== rb.status ? "FAIL" : "ok  ", name, ra.status, rb.status, JSON.stringify(seva(ra)), JSON.stringify(seva(rb)), d.slice(0, 3).join("; "));
  if (d.length || ra.status !== rb.status) fails++;
}
await new Promise((r) => setTimeout(r, 1500));
const { equal, report } = compareLogs(readLog("e2e", "baseline"), readLog("e2e", "new"));
console.log(equal ? "ok   outbound requests (DCC/WhatsApp/DRM/Meta) identical" : "FAIL outbound differ:\n" + report); if (!equal) fails++;
const dcc = readLog("e2e", "new").filter((e) => e.service === "dcc").map((e) => { const b = e.body || {}; return `${b.sevaCategory}/${b.sevaSubCategory}/${b.sevaSubCategoryCode}`; });
console.log("new -> DCC seva triples:", dcc.join(" | "));
await m.close(); process.exit(fails ? 1 : 0);
