import { query } from "../db/pg.js";
import { donations } from "../db/tables.js";
import { qi } from "../db/table.js";

const qiCol = (nameOrField, isColumn = false) => qi(isColumn ? nameOrField : donations.fieldToCol(nameOrField));

const normalize = (filter) => {
  if (Array.isArray(filter)) return filter.map(normalize);
  if (!filter || typeof filter !== "object" || filter instanceof Date || filter instanceof RegExp) return filter;
  const out = {};
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      out[key] = cond.map(normalize);
      continue;
    }
    if (cond && typeof cond === "object" && cond.$not instanceof RegExp && Object.keys(cond).length === 1) {
      const col = qiCol(key);
      const raw = [`(${col} IS NULL OR ${col} ${cond.$not.flags.includes("i") ? "!~*" : "!~"} ?)`, [cond.$not.source]];
      out.$and = [...(out.$and || []), { $raw: raw }];
      continue;
    }
    out[key] = cond;
  }
  return out;
};

const whereOf = (filter, params) => {
  const w = donations.buildWhere(normalize(filter), params);
  return w.sql ? ` WHERE ${w.sql}` : "";
};

async function claimUpdate(filter, patch, { client, order = "created_at, id" } = {}) {
  const params = [];
  const { cols, incs, unsets } = donations.toColumns(patch);
  const sets = [];
  for (const [c, v] of Object.entries(cols)) {
    params.push(v);
    sets.push(`${qiCol(c, true)} = $${params.length}`);
  }
  for (const [c, n] of Object.entries(incs)) {
    params.push(n);
    sets.push(`${qiCol(c, true)} = COALESCE(${qiCol(c, true)}, 0) + $${params.length}`);
  }
  for (const c of unsets) sets.push(`${qiCol(c, true)} = NULL`);
  if (!("updated_at" in cols)) sets.push(`"updated_at" = now()`);
  const where = whereOf(filter, params);
  const sql =
    typeof filter._id === "string"
      ? `UPDATE donations SET ${sets.join(", ")}${where} RETURNING *`
      : `UPDATE donations SET ${sets.join(", ")} WHERE id = (SELECT id FROM donations${where} ORDER BY ${order} LIMIT 1 FOR UPDATE) RETURNING *`;
  const r = await (client || { query }).query(sql, params);
  return donations.fromRow(r.rows[0]);
}

// SELECT with an explicit (trusted, literal) ORDER BY, for orderings the repo cannot express (NULLS FIRST).
async function selectDonations(filter, { orderBy = "", limit, skip, lean = false } = {}) {
  const params = [];
  let sql = `SELECT * FROM donations${whereOf(filter, params)}${orderBy ? ` ORDER BY ${orderBy}` : ""}`;
  if (limit != null) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  if (skip) {
    params.push(skip);
    sql += ` OFFSET $${params.length}`;
  }
  return (await query(sql, params)).rows.map((r) => donations.fromRow(r, { lean }));
}

// Mongo's .limit(): 0, NaN and Infinity mean "no limit"; negatives and fractions use their truncated magnitude.
const mongoLimit = (n) => {
  const x = Math.trunc(Math.abs(Number(n)));
  return Number.isFinite(x) && x > 0 ? Math.min(x, 2147483647) : undefined;
};

// A Date used as a filter bound: Mongoose rejected Invalid Date; dates before Postgres' minimum match everything.
const dbDateBound = (d, path = "createdAt") => {
  if (Number.isNaN(d.getTime())) {
    const err = new Error(
      `Cast to date failed for value "Invalid Date" (type Date) at path "${path}" for model "donation"`
    );
    err.name = "CastError";
    throw err;
  }
  return d.getTime() < -62135596800000 ? new Date(-62135596800000) : d;
};

const PAYMENT_ERROR_KEYS = [
  "paymentId",
  "code",
  "description",
  "source",
  "step",
  "reason",
  "method",
  "bank",
  "wallet",
  "upiFlow",
  "cardNetwork",
  "at",
];
// Mongo replaced the whole paymentError subdocument; columns not supplied must be cleared.
const wholePaymentError = (err) => Object.fromEntries(PAYMENT_ERROR_KEYS.map((k) => [k, err[k] ?? null]));

const DONATIONS_PAGE_SQL_REGEX = "^donations(/|$)";

export {
  donations,
  claimUpdate,
  selectDonations,
  mongoLimit,
  dbDateBound,
  wholePaymentError,
  normalize as normalizeFilter,
  DONATIONS_PAGE_SQL_REGEX,
};
