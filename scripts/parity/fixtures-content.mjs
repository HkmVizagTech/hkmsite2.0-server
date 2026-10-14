// Content-slice fixtures: creates documents that the test data lacks (event registrations, important dates,
// volunteer events/registrations, darshan photos) on the BASELINE server, then copies the new documents into
// the Postgres database with the re-runnable migration, so both sides start with identical ids.
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/fixtures-content.mjs http://localhost:9210
import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";
import { sign, call } from "./lib.mjs";

const [A] = process.argv.slice(2);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const admin = String((await mongo.db().collection("users").findOne({ role: "admin" }))._id);
const token = sign({ userId: admin, role: "admin" });
const event = await mongo
  .db()
  .collection("events")
  .findOne({}, { sort: { _id: 1 } });
const post = (path, body, headers = {}) => call(A, { method: "POST", path, body, token, headers });

for (const name of ["Fixture Alice", "fixture bob", "Carol Fixture"]) {
  const r = await post(`/events/${event._id}/register`, { name, phone: "9000000001", note: "n" });
  if (r.status !== 201) throw new Error(`register failed ${r.status}`);
}
await post(`/events/${event._id}/checkin/${(await mongo.db().collection("registrations").findOne({}))?.token}`);
for (const [title, date, type] of [
  ["Fixture Ekadashi", "2026-11-01T00:00:00.000Z", "Ekadashi"],
  ["Fixture Festival", "2026-12-25T00:00:00.000Z", "Festival"],
  ["Fixture Other", "2027-01-05T00:00:00.000Z", "Other"],
]) {
  const r = await post("/important-dates", { title, date, description: "d", type });
  if (r.status !== 201) throw new Error(`important date failed ${r.status}`);
}
const vol = await post("/volunteers/admin", {
  title: "Fixture Volunteer Drive",
  description: "Help out",
  date: "2026-12-01T00:00:00.000Z",
  slots: 5,
  formFields: [
    { id: "name", type: "text", label: "Name", required: true },
    { id: "email", type: "email", label: "Email", required: true },
    { id: "diet", type: "select", label: "Diet", options: ["veg", "jain"] },
  ],
});
if (vol.status !== 201) throw new Error(`volunteer failed ${vol.status}`);
for (const [n, e] of [
  ["V One", "v1@example.com"],
  ["V Two", "v2@example.com"],
]) {
  const r = await call(A, {
    method: "POST",
    path: `/volunteers/${vol.data.event._id}/register`,
    body: { responses: { name: n, email: e, diet: "veg" } },
  });
  if (r.status !== 201) throw new Error(`volunteer register failed ${r.status}`);
}
// The baseline's /darshan/sync needs a replica set (it uses a transaction); insert the documents it would write.
const now = new Date();
await mongo
  .db()
  .collection("darshans")
  .insertMany(
    [11, 12, 13].map((id, i) => ({
      vaikunthamId: id,
      imageUrl: `https://x.example/d${id}.jpg`,
      position: i,
      status: "active",
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    }))
  );
await mongo.close();
execFileSync("node", ["scripts/migrate-mongo-to-pg.js"], {
  env: { ...process.env, DEST_PG_URL: process.env.DATABASE_URL },
  stdio: ["ignore", "ignore", "inherit"],
});
console.log("content fixtures created and migrated");
