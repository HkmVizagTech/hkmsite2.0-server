const redis = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let client;
let connectPromise;

// FAIL FAST. node-redis's default reconnectStrategy retries forever, which
// means connect() to an unreachable Redis never resolves NOR rejects — any
// caller awaiting it hangs indefinitely. That hung the Razorpay webhook
// handler past Razorpay's delivery timeout and got the webhook auto-disabled.
// Cap connection time and retries so callers get a rejection within ~2s and
// can fall back to inline processing.
async function getClient() {
	if (client && client.isReady) return client;
	if (!connectPromise) {
		client = redis.createClient({
			url: REDIS_URL,
			socket: {
				connectTimeout: 2000,
				reconnectStrategy: (retries) => (retries >= 5 ? new Error('Redis unreachable') : Math.min(retries * 100, 500)),
			},
		});
		client.on('error', (err) => console.error('Redis client error:', err && err.message ? err.message : err));
		connectPromise = client.connect().catch((err) => {
			// Reset so a later call can retry a fresh connection (e.g. Redis
			// comes up after a deploy) instead of caching the failure forever.
			connectPromise = null;
			try { client.destroy(); } catch {}
			client = null;
			throw err;
		});
	}
	await connectPromise;
	return client;
}

async function enqueueJob(queueName, payload) {
	const c = await getClient();
	const str = JSON.stringify(payload);
	await c.lPush(queueName, str);
	return true;
}

async function popJob(queueName, timeout = 5) {
	const c = await getClient();
	const res = await c.brPop(queueName, timeout);
	if (!res) return null;
	const payload = JSON.parse(res.element);
	return payload;
}

// ---------------------------------------------------------------------------
// CACHE LAYER
//
// Rules this layer must never break, in priority order:
//
//   1. A cache is an optimisation. Redis being slow, down, or misconfigured
//      must never fail a request, and must never make a request slower than
//      it would have been with no cache at all. Every operation below is
//      bounded by a timeout and swallows its own errors.
//
//   2. Point 1 is not satisfied by try/catch alone. getClient() takes ~2s to
//      reject when Redis is unreachable (connectTimeout 2000). Paying that on
//      every request would make an outage catastrophically slower than having
//      no cache — the exact failure mode this file's header comment describes.
//      Hence the circuit breaker: after a few consecutive failures we stop
//      calling Redis entirely for a cooldown, and serve straight from Mongo.
//
//   3. Reads are one round trip. This Redis may live in another Railway
//      project reached over the public proxy, where a round trip is tens of
//      milliseconds rather than a fraction of one. Anything that needs two
//      sequential Redis calls to serve one request is not worth caching.
// ---------------------------------------------------------------------------

// Caching is on whenever a Redis URL is configured, unless explicitly disabled.
// REDIS_CACHE_ENABLED=false is the kill switch: it stops all cache reads and
// writes without touching the queue or requiring a code change.
const CACHE_ENABLED = String(process.env.REDIS_CACHE_ENABLED || 'true') !== 'false';

// Budget for a single cache operation. Generous enough for a cross-region
// public-proxy round trip, short enough that a stalled Redis costs less than
// the Mongo aggregation we are trying to avoid.
const CACHE_TIMEOUT_MS = Number(process.env.REDIS_CACHE_TIMEOUT_MS || 250);

// Prefix every key, so this database stays legible if anything else ever
// shares it (and so FLUSH-by-pattern is possible in an emergency).
const PREFIX = process.env.REDIS_CACHE_PREFIX || 'hkm';

// --- circuit breaker -------------------------------------------------------
const BREAKER_THRESHOLD = Number(process.env.REDIS_BREAKER_THRESHOLD || 3);
const BREAKER_COOLDOWN_MS = Number(process.env.REDIS_BREAKER_COOLDOWN_MS || 30000);

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

const stats = { hits: 0, misses: 0, errors: 0, skipped: 0, sets: 0, invalidations: 0 };

function breakerIsOpen() {
	return Date.now() < breakerOpenUntil;
}

function recordSuccess() {
	consecutiveFailures = 0;
	breakerOpenUntil = 0;
}

function recordFailure(err) {
	stats.errors += 1;
	consecutiveFailures += 1;
	if (consecutiveFailures >= BREAKER_THRESHOLD && !breakerIsOpen()) {
		breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
		console.warn(
			`Redis cache: ${consecutiveFailures} consecutive failures, skipping Redis for ${BREAKER_COOLDOWN_MS}ms.`,
			err && err.message ? err.message : err
		);
	}
}

/**
 * Runs a Redis operation with a hard time limit, returning `fallback` on any
 * error, timeout, or open breaker. Never throws.
 */
async function guarded(operation, fallback) {
	if (!CACHE_ENABLED || breakerIsOpen()) {
		stats.skipped += 1;
		return fallback;
	}

	let timer;
	try {
		const result = await Promise.race([
			(async () => operation(await getClient()))(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Redis operation timed out after ${CACHE_TIMEOUT_MS}ms`)), CACHE_TIMEOUT_MS);
			}),
		]);
		recordSuccess();
		return result;
	} catch (err) {
		recordFailure(err);
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}

const withPrefix = (key) => `${PREFIX}:${key}`;

/** Cached value for `key`, or null on miss / any failure. */
async function cacheGet(key) {
	const raw = await guarded((c) => c.get(withPrefix(key)), null);
	if (raw == null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		// Corrupt or hand-written value — treat as a miss rather than a crash.
		return null;
	}
}

/** Stores `value` under `key` for `ttlSeconds`. Silent on failure. */
async function cacheSet(key, value, ttlSeconds) {
	const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 0));
	let payload;
	try {
		payload = JSON.stringify(value);
	} catch {
		return false; // not serialisable — nothing to cache
	}
	const ok = await guarded(async (c) => {
		await c.set(withPrefix(key), payload, { EX: ttl });
		return true;
	}, false);
	if (ok) stats.sets += 1;
	return ok;
}

/**
 * Deletes keys. Accepts any mix of strings and arrays; empty/duplicate entries
 * are dropped so callers can pass conditional keys without guarding each one.
 * One round trip regardless of how many keys.
 */
async function cacheDel(...keys) {
	const flat = [...new Set(keys.flat().filter(Boolean))].map(withPrefix);
	if (!flat.length) return 0;
	const removed = await guarded((c) => c.del(flat), 0);
	if (removed) stats.invalidations += removed;
	return removed;
}

/**
 * Read-through cache. Returns the cached value when present, otherwise runs
 * `producer()`, caches its result and returns it.
 *
 * `producer` runs exactly as it would have without a cache, so a Redis outage
 * degrades to today's behaviour precisely. A producer that throws propagates
 * normally and nothing is cached — errors must never be memoised.
 */
async function cacheWrap(key, ttlSeconds, producer) {
	const cached = await cacheGet(key);
	if (cached !== null && cached !== undefined) {
		stats.hits += 1;
		return cached;
	}
	stats.misses += 1;

	const fresh = await producer();

	// Never cache an empty result. A producer returning null/undefined means
	// "not found", and memoising that keeps a 404 alive for the whole TTL —
	// so a campaigner whose page goes live, or a seva with its first donation,
	// would stay broken until the entry expired. Re-querying Mongo for genuine
	// misses is the cheap side of that trade.
	if (fresh === null || fresh === undefined) return fresh;

	// Don't await the write: the caller's response should not wait on Redis.
	// guarded() already swallows errors, so this cannot produce an unhandled
	// rejection.
	cacheSet(key, fresh, ttlSeconds);
	return fresh;
}

/** Key builders — one place, so invalidation can never drift from reads. */
const cacheKeys = {
	statsOverview: () => 'stats:overview',
	statsSqft: () => 'stats:sqft',
	// The per-seva donor wall is cached at full width and sliced per request,
	// so `limit` stays out of the key. One entry per seva means invalidation
	// can name the exact key instead of scanning.
	statsSeva: (sevaName) => `stats:seva:${String(sevaName || '').toLowerCase()}`,
	statsCategory: (type) => `stats:cat:${String(type || '').toLowerCase()}`,
	campaigner: (slug) => `campaigner:${String(slug || '').toLowerCase()}`,
};

/** Connection state and counters, for the health endpoint. */
function cacheStatus() {
	return {
		enabled: CACHE_ENABLED,
		configured: Boolean(process.env.REDIS_URL),
		connected: Boolean(client && client.isReady),
		breakerOpen: breakerIsOpen(),
		breakerOpensFor: breakerIsOpen() ? breakerOpenUntil - Date.now() : 0,
		consecutiveFailures,
		timeoutMs: CACHE_TIMEOUT_MS,
		...stats,
	};
}

module.exports = {
	getClient,
	enqueueJob,
	popJob,
	cacheGet,
	cacheSet,
	cacheDel,
	cacheWrap,
	cacheKeys,
	cacheStatus,
};
