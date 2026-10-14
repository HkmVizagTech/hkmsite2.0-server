// GET /blogs?q=... on both servers for a battery of queries drawn from the real corpus: single words (every
// distinct token), word pairs, "phrases", -negations, stop words, accents, punctuation. Compares ids + totals.
//   SRC_MONGO_URI=... node scripts/parity/blog-search.mjs http://localhost:9210 http://localhost:9211 [count]
import { MongoClient } from "mongodb";
import { rawTokens } from "../../src/domain/mongoText.js";

const [A, B, countArg] = process.argv.slice(2);
const N = Number(countArg || 1500);
const mongo = new MongoClient(process.env.SRC_MONGO_URI);
await mongo.connect();
const blogs = await mongo
  .db()
  .collection("blogs")
  .find({}, { projection: { title: 1, excerpt: 1, content: 1 } })
  .toArray();
await mongo.close();

let seed = 17;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const vocab = [...new Set(blogs.flatMap((b) => rawTokens([b.title, b.excerpt, b.content].join(" "))))];
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sample = () => {
  const b = pick(blogs);
  const t = String(b.content || b.title).replace(/<[^>]*>/g, " ");
  const i = Math.floor(rnd() * Math.max(1, t.length - 60));
  return t.slice(i, i + 5 + Math.floor(rnd() * 30)).trim();
};
const extras = [
  "The",
  "AND",
  "don't",
  "Krishna's",
  "krsna",
  "Kṛṣṇa",
  "Śrīla",
  "srila",
  "gītā",
  "bhagavad-gita",
  "gita.",
  "(gita)",
  "2026",
  "1",
  "e",
  "s",
  "a",
  "—",
  "é日本",
  "<script>",
  "' OR 1=1 --",
  "-1",
  "running",
  "runs",
  "prasadam",
  "TEMPLE",
  "temples",
  "ISKCON",
  "ekadashi",
  "",
  " ",
  "-",
  '"',
  "NaN",
  "null",
  ".*",
  "%",
  "\\",
  "(",
  "[",
];
const queries = [...extras, ...vocab.slice(0, 400)];
while (queries.length < N) {
  const r = rnd();
  const w = () => (rnd() < 0.2 ? pick(extras) : pick(vocab));
  if (r < 0.3) queries.push(`${w()} ${w()}`);
  else if (r < 0.5) queries.push(`"${sample()}"`);
  else if (r < 0.65) queries.push(`${w()} -${w()}`);
  else if (r < 0.75) queries.push(`${w()} -"${sample()}"`);
  else if (r < 0.85) queries.push(`${w()} "${sample().slice(0, 25)}" ${w()}`);
  else queries.push(`${w()}${pick([" ", "  ", "-", ",", " - ", "\t", "'"])}${w()}`);
}
const get = async (base, q, extra = "") => {
  const res = await fetch(`${base}/blogs?q=${encodeURIComponent(q)}&status=all&limit=50${extra}`);
  return { status: res.status, data: await res.json().catch(() => null) };
};
let bad = 0;
const t0 = Date.now();
for (const q of queries) {
  const [a, b] = [await get(A, q), await get(B, q)];
  const key = (r) =>
    r.status === 200 ? JSON.stringify([r.data.total, r.data.blogs.map((x) => x._id)]) : `${r.status} ${r.data?.error}`;
  if (key(a) !== key(b)) {
    bad++;
    if (bad <= 15)
      console.log("MISMATCH", JSON.stringify(q), "\n  A", key(a).slice(0, 160), "\n  B", key(b).slice(0, 160));
  }
}
// paging, filters and duplicate params combined with q
for (const extra of [
  "&page=2&limit=3",
  "&category=Recipes",
  "&featured=true",
  "&tag=Krishna",
  "&status=draft",
  "&q=other",
  "&limit=0",
  "&page=abc",
]) {
  for (const q of ["krishna", "temple prasadam", "-gita krishna"]) {
    const [a, b] = [await get(A, q, extra), await get(B, q, extra)];
    const key = (r) =>
      r.status === 200
        ? JSON.stringify([r.data.total, r.data.page, r.data.limit, r.data.blogs.map((x) => x._id)])
        : `${r.status} ${r.data?.error}`;
    if (key(a) !== key(b)) {
      bad++;
      console.log("MISMATCH", JSON.stringify(q), extra, "\n  A", key(a).slice(0, 200), "\n  B", key(b).slice(0, 200));
    }
  }
}
console.log(
  `blog search: ${queries.length} queries + paging/filter combos, ${bad} mismatches, ${((Date.now() - t0) / 1000).toFixed(0)}s`
);
process.exit(bad ? 1 : 0);
