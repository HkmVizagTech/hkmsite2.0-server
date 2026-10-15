import "../../src/config/timezone.js";
import { connectDb, closeDb } from "../../src/db/pg.js";
import { donations } from "../../src/db/tables.js";
import { buildDccPayload } from "../../src/services/dcc.service.js";

await connectDb();
const BATCH = 400;
const fields = ["donorName", "donorPhone", "donorEmail", "gender", "PAN", "amount", "accountType", "sevaCategory", "sevaSubCategory", "sevaSubCategoryCode", "modeOfPayment", "gatewayPaymentId", "transactionDate", "enrolledBy", "address.fullAddress", "address.state", "address.city", "address.pinCode"];
const get = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
const norm = (v) => (v === undefined || v === null || v === "" ? null : String(v));
const stats = Object.fromEntries(fields.map((f) => [f, { diff: 0, examples: [] }]));
let total = 0, identical = 0, skipped = 0;
for (let skip = 0; ; skip += BATCH) {
  const rows = await donations.find({ dccPayload: { $ne: null } }, { sort: { createdAt: 1 }, skip, limit: BATCH });
  if (!rows.length) break;
  for (const d of rows) {
    const sent = d.dccPayload;
    if (!sent || typeof sent !== "object" || !sent.donorName) { skipped++; continue; }
    total++;
    const built = buildDccPayload(d, sent.gatewayPaymentId);
    let same = true;
    for (const f of fields) {
      if (norm(get(sent, f)) !== norm(get(built, f))) {
        same = false;
        stats[f].diff++;
        if (stats[f].examples.length < 2) stats[f].examples.push({ id: d._id, sent: get(sent, f), rebuilt: get(built, f) });
      }
    }
    if (same) identical++;
  }
}
console.log(`real donations sent to DCC (replayed): ${total}   skipped (no usable payload): ${skipped}`);
console.log(`rebuilt request IDENTICAL in every field to what production sent: ${identical}/${total}`);
for (const [f, s] of Object.entries(stats)) if (s.diff) console.log(`  field ${f}: ${s.diff} differ, e.g. ${JSON.stringify(s.examples[0])}`);
await closeDb();
