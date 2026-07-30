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
				connectTimeout: 1500,
				reconnectStrategy: (retries) => (retries >= 2 ? new Error('Redis unreachable — giving up') : 250),
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

module.exports = { getClient, enqueueJob, popJob };
