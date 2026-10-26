// After a UI session against both stacks: compares the rows the UI created (donations, registrations) and the
// outbound requests to the faked outside services.   node scripts/parity/compare-ui-state.mjs [envName]
import { MongoClient } from "mongodb";
import pg from "pg";
import { diff, normalize } from "./lib.mjs";
import { readLog, compareLogs } from "./mocks/ctl.mjs";
const ENV = process.argv[2] || "e2e";
const m = new MongoClient(`mongodb://127.0.0.1:27018/m_${ENV}`);
await m.connect();
const p = new pg.Client({ connectionString: `postgres://hkm@localhost:5433/pg_${ENV}` });
await p.connect();
pg.types.setTypeParser(1700, (v) => parseFloat(v));
await new Promise((r) => setTimeout(r, 2500));
const IGN = /^(_id|id|createdAt|updatedAt|date|donorRecordId|donorId|.*At|razorpay.*Id|subscriptionId|transactionId|token|eventId|seq|extra|__v)$/;
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !IGN.test(k) && v !== null && v !== undefined));
const snake = (s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
let bad = 0;
for (const [coll, table, where] of [["donations", "donations", { donorName: /^UI / }], ["registrations", "event_registrations", {}]]) {
  const a = (await m.db().collection(coll).find(coll === "donations" ? where : { "data.name": "UI Reg" }).sort({ _id: 1 }).toArray()).map(strip);
  const rows = coll === "donations" ? (await p.query("select * from donations where donor_name like 'UI %' order by seq")).rows : (await p.query("select * from event_registrations where data->>'name'='UI Reg' order by seq")).rows;
  const b = rows.map((r) => strip(Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v]))));
  const norm = (list) => list.map((o) => { const out = {}; for (const [k, v] of Object.entries(o)) { if (/^(utm|upi|pe|prasadam|ship|saved|attendance)[A-Z_]/.test(k)) continue; if (typeof v === "object" && v && !(v instanceof Date) && !Array.isArray(v)) continue; out[k] = v; } return normalize(out); });
  const na = norm(a), nb = norm(b);
  const keys = new Set([...na.flatMap(Object.keys)]);
  const projB = nb.map((o) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.has(k))));
  const d = diff(na, projB);
  console.log(`${d.length ? "FAIL" : "ok  "} ${coll}: ${a.length} mongo vs ${b.length} pg rows created by the UI ${d.slice(0, 5).join("; ")}`);
  if (d.length || a.length !== b.length) bad++;
}
const { equal, report } = compareLogs(readLog(ENV, "baseline"), readLog(ENV, "new"));
console.log(equal ? "ok   outbound requests to Razorpay/DCC/WhatsApp/Meta/DRM identical" : "FAIL outbound differ:\n" + report);
if (!equal) bad++;
await m.close(); await p.end();
process.exit(bad ? 1 : 0);
