import { many } from "../db/pg.js";
import { donations } from "../db/tables.js";

export const IST_ZONE = "Asia/Kolkata";

// Seva label expressions (Mongo $ifNull chains).
export const SEVA_OR_TYPE = "COALESCE(seva_name, type)";
export const SEVA_OR_TYPE_GENERAL = "COALESCE(seva_name, type, 'General')";
export const SEVA_OR_GENERAL = "COALESCE(seva_name, 'General')";

// Matches "donations" or "donations/<anything>"; used both as a repo filter value (RegExp) and in raw SQL.
export const DONATIONS_DOMAIN_PATTERN = /^donations(\/|$)/;
// Mongo { sourcePage: { $not: /^donations(\/|$)/ } }: also true when sourcePage is absent.
export const EXCLUDE_DONATIONS_PAGE = { $raw: ["(source_page IS NULL OR source_page !~ ?)", ["^donations(/|$)"]] };

export const NEEDS_ATTENTION_OR = [{ dccSyncStatus: "failed" }, { whatsappReceiptSentAt: null }];

export { castId } from "./donationCast.js";

export const castNumber = (v) => {
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Cast to Number failed for value "${v}"`);
  return n;
};

export const istMonth = (col) => `to_char(${col} AT TIME ZONE '${IST_ZONE}', 'YYYY-MM')`;
export const istDay = (col) => `to_char(${col} AT TIME ZONE '${IST_ZONE}', 'YYYY-MM-DD')`;

const FALSE_FILTER = { $raw: ["FALSE", []] };

// aggregate $match does not cast: an array or a plain sub-document compared to a scalar field matches nothing.
export function aggMatch(filter) {
  const out = {};
  let never = false;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or" || key === "$and" || key === "$nor") out[key] = cond.map(aggMatch);
    else if (key === "$raw") out[key] = cond;
    else if (Array.isArray(cond)) never = true;
    else if (cond && typeof cond === "object" && !(cond instanceof RegExp) && !(cond instanceof Date)) {
      if (Object.keys(cond).some((k) => k.startsWith("$"))) out[key] = cond;
      else never = true;
    } else out[key] = cond;
  }
  return never ? { $and: [FALSE_FILTER, out] } : out;
}

// Runs SELECT <select> FROM donations WHERE <mongo-style filter> [GROUP BY ..] [ORDER BY ..] [LIMIT n].
export async function aggregate(filter, select, { groupBy, orderBy, limit, offset } = {}) {
  const params = [];
  const w = donations.buildWhere(aggMatch(filter), params);
  let sql =
    `SELECT ${select} FROM donations` + (w.sql ? ` WHERE ${w.sql}` : "") + (groupBy ? ` GROUP BY ${groupBy}` : "");
  // Wrapped so ORDER BY can use expressions over the output aliases.
  if (groupBy) sql = `SELECT * FROM (${sql}) g`;
  sql +=
    (orderBy ? ` ORDER BY ${orderBy}` : "") +
    (limit ? ` LIMIT ${Number(limit)}` : "") +
    (offset ? ` OFFSET ${Number(offset)}` : "");
  return many(sql, params);
}

// { total, count } over a filter; zeros when nothing matches (Mongo's "[0]?.total || 0").
export async function sumCount(filter) {
  const [row] = await aggregate(filter, "COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count");
  return { total: Number(row.total) || 0, count: Number(row.count) || 0 };
}

export const sumTotal = async (filter) => (await sumCount(filter)).total;

// Number of groups for GROUP BY <keyExpr> (Mongo $group + $count).
export async function countGroups(filter, keyExpr) {
  const params = [];
  const w = donations.buildWhere(aggMatch(filter), params);
  const rows = await many(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM donations${w.sql ? ` WHERE ${w.sql}` : ""} GROUP BY ${keyExpr}) g`,
    params
  );
  return Number(rows[0].n) || 0;
}

export const pick = (doc, fields) => {
  const out = { _id: doc._id };
  for (const f of fields) if (doc[f] !== undefined) out[f] = doc[f];
  return out;
};

export const cleanText = (v, max) =>
  String(v || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
