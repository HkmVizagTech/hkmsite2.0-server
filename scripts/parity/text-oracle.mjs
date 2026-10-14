// Differential test of src/domain/mongoText.js against MongoDB's own $text on the real blog corpus.
// Reads the `blogs` collection (which carries the original text index) of SRC_MONGO_URI; never writes.
//   SRC_MONGO_URI=mongodb://127.0.0.1:27018/test node scripts/parity/text-oracle.mjs [seed] [randomQueries]
import { MongoClient } from "mongodb";
import { rawTokens, parseQuery, indexDocument, matches } from "../../src/domain/mongoText.js";

const [seedArg, nArg] = process.argv.slice(2);
const c = await MongoClient.connect(process.env.SRC_MONGO_URI);
const col = c.db().collection("blogs");
const blogs = await col.find({}, { projection: { title: 1, excerpt: 1, content: 1 } }).toArray();
const docs = blogs.map((b) => ({ id: String(b._id), idx: indexDocument([b.title, b.excerpt, b.content]) }));
const emu = (q) =>
  docs
    .filter((d) => matches(parseQuery(q), d.idx))
    .map((d) => d.id)
    .sort();
const mongo = async (q) => {
  try {
    return (await col.find({ $text: { $search: q } }, { projection: { _id: 1 } }).toArray())
      .map((d) => String(d._id))
      .sort();
  } catch (e) {
    return "ERR " + e.message;
  }
};
let bad = 0,
  total = 0;
const check = async (q) => {
  total++;
  const a = await mongo(q),
    b = emu(q);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++;
    if (bad <= 20)
      console.log("MISMATCH", JSON.stringify(q), "mongo", Array.isArray(a) ? a.length : a, "emu", b.length);
  }
};
const vocab = [...new Set(blogs.flatMap((b) => rawTokens([b.title, b.excerpt, b.content].join(" "))))];
for (const t of vocab) await check(t);
console.log(`single-token battery: ${vocab.length} tokens, ${bad} mismatches`);
let seed = Number(seedArg || 3);
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const puncts = [
  '"',
  "-",
  " ",
  "  ",
  "\t",
  "\n",
  "'",
  "\u2019",
  "(",
  ")",
  "\u2014",
  ".",
  ",",
  "!",
  "?",
  "*",
  "\\",
  "$",
  "\u00e9",
  "\u65e5\u672c",
  "\u00a0",
  "_",
  "/",
  "#",
  "+",
  "=",
  "<",
  ">",
];
const words = (n) => Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]);
const textSample = () => {
  const b = blogs[Math.floor(rnd() * blogs.length)];
  const t = String(b.content || b.title).replace(/<[^>]*>/g, " ");
  const i = Math.floor(rnd() * Math.max(1, t.length - 60));
  return t.slice(i, i + 5 + Math.floor(rnd() * 30));
};
for (const q of [
  "",
  " ",
  "-",
  "--",
  "- a",
  '"',
  '""',
  '-"x y"',
  "krishna -krishna",
  "-krishna",
  "krishna - krishna",
  "1e9",
  "NaN",
  "null",
  ".*",
  "\u00e9\u65e5\u672c",
  "x".repeat(300),
  "-1",
  "100000",
])
  await check(q);
for (let i = 0; i < Number(nArg || 10000); i++) {
  let q = "";
  const parts = 1 + Math.floor(rnd() * 5);
  for (let j = 0; j < parts; j++) {
    const r = rnd();
    if (r < 0.35) q += words(1)[0];
    else if (r < 0.5) q += '"' + textSample() + '"';
    else if (r < 0.6) q += "-" + words(1)[0];
    else if (r < 0.65) q += '-"' + textSample() + '"';
    else q += puncts[Math.floor(rnd() * puncts.length)];
    q += rnd() < 0.7 ? " " : puncts[Math.floor(rnd() * puncts.length)];
  }
  await check(q);
}
console.log(`total ${total} queries, ${bad} mismatches`);
await c.close();
process.exit(bad ? 1 : 0);
