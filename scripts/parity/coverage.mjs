import { readFileSync } from "node:fs";

const [routesFile, logFile, port] = process.argv.slice(2);
const routes = JSON.parse(readFileSync(routesFile, "utf8"));
const log = readFileSync(logFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split(" "))
  .filter((p) => p[0] === port);
const toRe = (path) => new RegExp("^" + path.replace(/\/$/, "").replace(/:[A-Za-z]+/g, "[^/]+") + "/?$");
const compiled = routes.map((r) => ({ ...r, re: toRe(r.path), params: (r.path.match(/:/g) || []).length }));
const hits = new Map();
for (const [, method, path, status] of log) {
  const cands = compiled.filter((r) => r.method === method && r.re.test(path)).sort((a, b) => a.params - b.params);
  const r = cands[0];
  if (!r) continue;
  const k = `${r.method} ${r.path}`;
  const h = hits.get(k) ?? { n: 0, statuses: new Set() };
  h.n++;
  h.statuses.add(status);
  hits.set(k, h);
}
const missed = compiled.filter((r) => !hits.has(`${r.method} ${r.path}`));
console.log(`routes hit: ${hits.size}/${compiled.length}`);
console.log(`NOT HIT (${missed.length}):`);
for (const r of missed) console.log(`  ${r.method} ${r.path}`);
