import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.SRC_MONGO_URI);
await client.connect();
const db = client.db();
const walk = (v, path, out) => {
  if (v === null) out.add(path);
  else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && v.constructor?.name !== "ObjectId")
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
};
for (const c of (await db.listCollections().toArray()).map((x) => x.name).sort()) {
  const counts = new Map();
  let n = 0;
  for await (const d of db.collection(c).find({})) {
    n++;
    const paths = new Set();
    walk(d, "", paths);
    for (const p of paths) counts.set(p, (counts.get(p) || 0) + 1);
  }
  if (counts.size) console.log(c.padEnd(22), `(${n} docs)`, JSON.stringify(Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))));
}
await client.close();
