const MAX_ENTRIES = 1000; // keys are bounded (one per seva/category/campaigner); this is a safety cap

const store = new Map(); // key -> { json, expiresAt }
const stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };

function sweepIfFull() {
  if (store.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  // Still full: drop the oldest insertions (Map keeps insertion order).
  while (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
}

/** Cached value for `key`, or null on miss/expiry. */
async function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  try {
    return JSON.parse(entry.json);
  } catch {
    store.delete(key);
    return null;
  }
}

/** Stores `value` under `key` for `ttlSeconds`. */
async function cacheSet(key, value, ttlSeconds) {
  const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 0));
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return false; // not serialisable — nothing to cache
  }
  if (json === undefined) return false;
  sweepIfFull();
  store.delete(key); // re-insert so it counts as newest
  store.set(key, { json, expiresAt: Date.now() + ttl * 1000 });
  stats.sets += 1;
  return true;
}

/** Deletes keys. Accepts strings and arrays; empty/duplicate entries are ignored. */
async function cacheDel(...keys) {
  let removed = 0;
  for (const k of new Set(keys.flat().filter(Boolean))) if (store.delete(k)) removed += 1;
  stats.invalidations += removed;
  return removed;
}

async function cacheWrap(key, ttlSeconds, producer) {
  const cached = await cacheGet(key);
  if (cached !== null && cached !== undefined) {
    stats.hits += 1;
    return cached;
  }
  stats.misses += 1;
  const fresh = await producer();
  // Never cache "not found" — a campaigner page going live or a seva's first
  // donation must show up immediately, not after the TTL.
  if (fresh === null || fresh === undefined) return fresh;
  await cacheSet(key, fresh, ttlSeconds);
  return fresh;
}

/** Key builders — one place, so invalidation can never drift from reads. */
const cacheKeys = {
  statsOverview: () => "stats:overview",
  statsSqft: () => "stats:sqft",
  // The per-seva donor wall is cached at full width and sliced per request,
  // so `limit` stays out of the key.
  statsSeva: (sevaName) => `stats:seva:${String(sevaName || "").toLowerCase()}`,
  statsCategory: (type) => `stats:cat:${String(type || "").toLowerCase()}`,
  campaigner: (slug) => `campaigner:${String(slug || "").toLowerCase()}`,
};

/** Counters for the health endpoint. */
function cacheStatus() {
  return { backend: "memory", entries: store.size, ...stats };
}

export { cacheGet, cacheSet, cacheDel, cacheWrap, cacheKeys, cacheStatus };
