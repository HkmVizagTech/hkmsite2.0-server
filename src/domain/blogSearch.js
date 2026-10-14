import { many } from "../db/pg.js";
import { CastError } from "./odm.js";
import { parseQuery, indexDocument, matches } from "./mongoText.js";

// `$text` search over title/excerpt/content as MongoDB's text index did, evaluated against a per-process
// index of each post (rebuilt only for posts whose updated_at changed).
const cache = new Map();

const loadIndex = async () => {
  const stamps = await many("SELECT id, updated_at FROM blogs");
  const live = new Set(stamps.map((r) => r.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  const stale = stamps.filter((r) => cache.get(r.id)?.stamp !== +r.updated_at).map((r) => r.id);
  if (stale.length) {
    const rows = await many("SELECT id, title, excerpt, content, updated_at FROM blogs WHERE id = ANY($1)", [stale]);
    for (const r of rows)
      cache.set(r.id, { stamp: +r.updated_at, idx: indexDocument([r.title, r.excerpt, r.content]) });
  }
};

export async function textSearchIds(search) {
  if (typeof search !== "string") throw new CastError("string", search, "$text.$search", undefined, "blog");
  const parsed = parseQuery(search);
  await loadIndex();
  const ids = [];
  for (const [id, { idx }] of cache) if (matches(parsed, idx)) ids.push(id);
  return ids;
}
