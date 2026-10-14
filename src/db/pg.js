import { randomBytes } from "node:crypto";
import pg from "pg";

const { Pool, types } = pg;

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

let pool;
const getPool = () => {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 15),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", (err) => console.error("[pg] idle client error:", err.message));
  }
  return pool;
};

const query = (text, params) => getPool().query(text, params);
const many = async (text, params) => (await query(text, params)).rows;
const one = async (text, params) => (await query(text, params)).rows[0] || null;

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

const newId = () => Math.floor(Date.now() / 1000).toString(16).padStart(8, "0") + randomBytes(8).toString("hex");
const isId = (v) => typeof v === "string" && /^[0-9a-f]{24}$/i.test(v);

async function connectDb() {
  const r = await query("SELECT 1 AS ok");
  if (!r.rows[0] || r.rows[0].ok !== 1) throw new Error("Postgres ping failed");
  console.log("Postgres connected");
}
const dbState = async () => { try { await query("SELECT 1"); return "connected"; } catch (_) { return "disconnected"; } };
const closeDb = async () => { if (pool) { await pool.end(); pool = undefined; } };

export { getPool, query, one, many, tx, newId, isId, connectDb, dbState, closeDb };
