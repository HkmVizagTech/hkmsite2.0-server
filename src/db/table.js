import { query, newId } from "./pg.js";

const snake = (s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const qi = (c) => `"${c.replace(/"/g, '""')}"`;

const columnDefaults = new Map();
const tableColumns = new Map();

export async function loadDefaults() {
  const { rows } = await query(
    `SELECT table_name, column_name, column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND column_default IS NOT NULL AND is_nullable = 'YES'
       AND column_name NOT IN ('id', 'created_at', 'updated_at')`
  );
  columnDefaults.clear();
  tableColumns.clear();
  const { rows: cols } = await query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  for (const c of cols) {
    if (!tableColumns.has(c.table_name)) tableColumns.set(c.table_name, new Set());
    tableColumns.get(c.table_name).add(c.column_name);
  }
  for (const r of rows) {
    if (/\(\)/.test(r.column_default)) continue;
    const { rows: v } = await query(`SELECT (${r.column_default}) AS v`);
    if (!columnDefaults.has(r.table_name)) columnDefaults.set(r.table_name, {});
    columnDefaults.get(r.table_name)[r.column_name] = v[0].v;
  }
}

const prefix = (p, keys) => Object.fromEntries(keys.map((k) => [k, p + snake(k)]));

function defineTable({
  table,
  nests = {},
  json = [],
  renames = {},
  keepNull = [],
  timestamps = true,
  serialId = false,
  hidden = [],
}) {
  const colOfField = {}; // "utm.source" -> "utm_source"; "status" -> "status"
  const nestOfCol = {};
  for (const [field, map] of Object.entries(nests)) {
    for (const [key, col] of Object.entries(map)) {
      colOfField[`${field}.${key}`] = col;
      nestOfCol[col] = [field, key];
    }
  }
  const fieldToCol = (f) => {
    if (f === "_id") return "id";
    if (colOfField[f]) return colOfField[f];
    if (renames[f]) return renames[f];
    return snake(f);
  };
  const knownCol = (col) => !tableColumns.has(table) || tableColumns.get(table).has(col);
  const jsonSet = new Set(json);
  const keepNullSet = new Set(keepNull);
  const hiddenSet = new Set(hidden);

  const fromRow = (row, { lean = false } = {}) => {
    if (!row) return null;
    const doc = {};
    const nested = {};
    const extras = {};
    const nullSet = new Set(row.extra?.$nulls ?? []);
    for (const [col, val] of Object.entries(row)) {
      if (col === "id") {
        doc._id = val;
        continue;
      }
      if (hiddenSet.has(col)) continue;
      if (col === "extra") {
        if (val) for (const [k, v] of Object.entries(val)) if (k !== "$nulls" && lean && !(k in doc)) extras[k] = v;
        continue;
      }
      const fieldPath = nestOfCol[col]
        ? nestOfCol[col].join(".")
        : Object.keys(renames).find((k) => renames[k] === col) || camel(col);
      const fallback = !lean && val === null && !nullSet.has(fieldPath) ? columnDefaults.get(table)?.[col] : undefined;
      const value = fallback !== undefined ? fallback : val;
      if (nestOfCol[col]) {
        const [field, key] = nestOfCol[col];
        if (value !== null && value !== undefined) (nested[field] = nested[field] || {})[key] = value;
        continue;
      }
      const field = Object.keys(renames).find((k) => renames[k] === col) || camel(col);
      if (value === null && !(keepNullSet.has(field) && !lean)) continue;
      doc[field] = value;
    }
    for (const [field, obj] of Object.entries(nested)) doc[field] = obj;
    for (const [k, v] of Object.entries(extras)) if (!(k in doc)) doc[k] = v;
    for (const path of nullSet) {
      const [root, child] = path.split(".");
      if (child === undefined) {
        if (doc[root] === undefined) doc[root] = null;
      } else if (doc[root] === undefined) doc[root] = { [child]: null };
      else if (doc[root] && typeof doc[root] === "object" && doc[root][child] === undefined) doc[root][child] = null;
    }
    return doc;
  };

  const toColumns = (patch = {}) => {
    const cols = {},
      incs = {},
      unsets = [],
      nulls = [],
      unsetPaths = [];
    const put = (field, value) => {
      if (value === undefined) return;
      if (value === null && nests[field]) {
        for (const col of Object.values(nests[field])) if (knownCol(col)) cols[col] = null;
        nulls.push(field);
        return;
      }
      if (nests[field] && value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
        for (const key of Object.keys(nests[field]))
          if (value[key] !== undefined && knownCol(nests[field][key])) {
            cols[nests[field][key]] = value[key];
            if (value[key] === null) nulls.push(`${field}.${key}`);
          }
        return;
      }
      const col = fieldToCol(field);
      if (!knownCol(col)) return;
      if (value === null) nulls.push(field);
      cols[col] = jsonSet.has(field) && value !== null ? JSON.stringify(value) : value;
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "$set") {
        for (const [f, x] of Object.entries(v)) put(f, x);
      } else if (k === "$inc") {
        for (const [f, n] of Object.entries(v)) incs[fieldToCol(f)] = n;
      } else if (k === "$unset") {
        for (const f of Array.isArray(v) ? v : Object.keys(v)) {
          unsetPaths.push(f);
          if (nests[f]) Object.values(nests[f]).forEach((c) => unsets.push(c));
          else unsets.push(fieldToCol(f));
        }
      } else if (k === "_id" || k === "id") continue;
      else if (k === "createdAt") cols.created_at = v;
      else if (k === "updatedAt") cols.updated_at = v;
      else put(k, v);
    }
    return { cols, incs, unsets, nulls, unsetPaths };
  };

  const buildWhere = (filter = {}, params = [], depth = 0) => {
    const parts = [];
    const bind = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    for (const [key, cond] of Object.entries(filter)) {
      if (cond === undefined) continue;
      if (key === "$or" || key === "$and" || key === "$nor") {
        const subs = cond.map((f) => buildWhere(f, params, depth + 1).sql).filter(Boolean);
        if (subs.length)
          parts.push(
            key === "$or"
              ? `(${subs.join(" OR ")})`
              : key === "$nor"
                ? `NOT (${subs.join(" OR ")})`
                : `(${subs.join(" AND ")})`
          );
        continue;
      }
      if (key === "$raw") {
        let i = 0;
        const [text, vals = []] = cond;
        parts.push("(" + text.replace(/\?/g, () => bind(vals[i++])) + ")");
        continue;
      }
      const colName = fieldToCol(key);
      const col = knownCol(colName) ? qi(colName) : "NULL::text";
      if (cond === null) {
        parts.push(`${col} IS NULL`);
        continue;
      }
      if (cond instanceof Date || typeof cond !== "object" || Array.isArray(cond)) {
        parts.push(`${col} = ${bind(cond)}`);
        continue;
      }
      if (cond instanceof RegExp) {
        parts.push(`${col} ${cond.flags.includes("i") ? "~*" : "~"} ${bind(cond.source)}`);
        continue;
      }
      for (const [op, v] of Object.entries(cond)) {
        switch (op) {
          case "$eq":
            parts.push(v === null ? `${col} IS NULL` : `${col} = ${bind(v)}`);
            break;
          case "$ne":
            parts.push(v === null ? `${col} IS NOT NULL` : `${col} IS DISTINCT FROM ${bind(v)}`);
            break;
          case "$gt":
            parts.push(`${col} > ${bind(v)}`);
            break;
          case "$gte":
            parts.push(`${col} >= ${bind(v)}`);
            break;
          case "$lt":
            parts.push(`${col} < ${bind(v)}`);
            break;
          case "$lte":
            parts.push(`${col} <= ${bind(v)}`);
            break;
          case "$in": {
            const hasNull = v.includes(null);
            const rest = v.filter((x) => x !== null);
            const sub = [];
            if (rest.length) sub.push(`${col} = ANY(${bind(rest)})`);
            if (hasNull) sub.push(`${col} IS NULL`);
            parts.push(sub.length ? `(${sub.join(" OR ")})` : "FALSE");
            break;
          }
          case "$nin": {
            const hasNull = v.includes(null);
            const rest = v.filter((x) => x !== null);
            const sub = [];
            if (rest.length) sub.push(`(${col} IS NULL OR NOT (${col} = ANY(${bind(rest)})))`);
            if (hasNull) sub.push(`${col} IS NOT NULL`);
            parts.push(sub.length ? sub.join(" AND ") : "TRUE");
            break;
          }
          case "$exists":
            parts.push(v ? `${col} IS NOT NULL` : `${col} IS NULL`);
            break;
          case "$regex": {
            const src = v instanceof RegExp ? v.source : String(v);
            const ci = (v instanceof RegExp && v.flags.includes("i")) || String(cond.$options || "").includes("i");
            parts.push(`${col} ${ci ? "~*" : "~"} ${bind(src)}`);
            break;
          }
          case "$options":
            break;
          default:
            throw new Error(`table(${table}): unsupported filter operator ${op}`);
        }
      }
    }
    return { sql: parts.join(" AND "), params };
  };

  const selectList = (fields) => {
    if (!fields || !fields.length) return "*";
    const cols = new Set(["id"]);
    for (const f of fields) {
      if (f === "_id") continue;
      if (nests[f]) Object.values(nests[f]).forEach((c) => cols.add(c));
      else cols.add(fieldToCol(f));
    }
    const list = [...cols].filter((c) => knownCol(c)).map(qi);
    if (knownCol("extra")) {
      const selected = fields.filter((f) => /^[A-Za-z0-9_.$]+$/.test(f)).map((f) => `'${f}'`);
      list.push(
        `jsonb_build_object('$nulls', COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements_text("extra"->'$nulls') p WHERE p = ANY(ARRAY[${selected.join(",") || "''"}]::text[]) OR split_part(p, '.', 1) = ANY(ARRAY[${selected.join(",") || "''"}]::text[])), '[]'::jsonb)) AS "extra"`
      );
    }
    return list.join(", ");
  };
  const orderBy = (sort) => {
    if (!sort) return "";
    const items = Object.entries(sort).map(
      ([f, d]) => `${qi(fieldToCol(f))} ${d === -1 || d === "desc" ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`
    );
    return items.length ? ` ORDER BY ${items.join(", ")}` : "";
  };
  const wherePart = (filter, params) => {
    const w = buildWhere(filter, params);
    return w.sql ? ` WHERE ${w.sql}` : "";
  };

  const buildSet = (patch, params, { touch = true } = {}) => {
    const { cols, incs, unsets, nulls, unsetPaths } = toColumns(patch);
    const sets = [];
    for (const [c, v] of Object.entries(cols)) {
      params.push(v);
      sets.push(`${qi(c)} = $${params.length}`);
    }
    for (const [c, n] of Object.entries(incs)) {
      params.push(n);
      sets.push(`${qi(c)} = COALESCE(${qi(c)}, 0) + $${params.length}`);
    }
    for (const c of unsets) sets.push(`${qi(c)} = NULL`);
    if ((nulls.length || unsetPaths.length) && !("extra" in cols) && knownCol("extra")) {
      params.push(nulls);
      const add = params.length;
      params.push(unsetPaths);
      const drop = params.length;
      sets.push(
        `"extra" = jsonb_set(COALESCE("extra", '{}'::jsonb), '{$nulls}', to_jsonb(ARRAY(SELECT DISTINCT p FROM unnest(ARRAY(SELECT jsonb_array_elements_text(COALESCE("extra"->'$nulls', '[]'::jsonb))) || $${add}::text[]) AS p WHERE NOT (p = ANY($${drop}::text[])))))`
      );
    }
    if (touch && timestamps && !("updated_at" in cols)) {
      params.push(new Date());
      sets.push(`"updated_at" = $${params.length}`);
    }
    return sets;
  };

  const repo = {
    table,
    fromRow,
    nests,
    toColumns,
    buildWhere,
    fieldToCol,
    newId,

    async find(filter = {}, { sort, skip, limit, fields, client, lean = false } = {}) {
      const params = [];
      let sql = `SELECT ${selectList(fields)} FROM ${qi(table)}${wherePart(filter, params)}${orderBy(sort)}`;
      if (limit != null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      if (skip) {
        params.push(skip);
        sql += ` OFFSET $${params.length}`;
      }
      return (await (client || { query }).query(sql, params)).rows.map((r) => fromRow(r, { lean }));
    },
    async findOne(filter = {}, opts = {}) {
      return (await repo.find(filter, { ...opts, limit: 1 }))[0] || null;
    },
    async findById(id, opts = {}) {
      return id ? repo.findOne({ _id: String(id) }, opts) : null;
    },
    async count(filter = {}, { client } = {}) {
      const params = [];
      const r = await (client || { query }).query(
        `SELECT count(*) AS n FROM ${qi(table)}${wherePart(filter, params)}`,
        params
      );
      return Number(r.rows[0].n);
    },
    async exists(filter = {}) {
      return (await repo.count(filter)) > 0;
    },
    async distinct(field, filter = {}) {
      const params = [];
      const c = qi(fieldToCol(field));
      const r = await query(`SELECT DISTINCT ${c} AS v FROM ${qi(table)}${wherePart(filter, params)}`, params);
      return r.rows.map((x) => x.v).filter((v) => v !== null);
    },

    async insert(doc, { client, onConflictDoNothing = false, lean = false } = {}) {
      const { cols, nulls } = toColumns({ ...doc });
      for (const f of keepNull) if (doc[f] === undefined && !nulls.includes(f)) nulls.push(f);
      if (nulls.length && !("extra" in cols) && knownCol("extra"))
        cols.extra = JSON.stringify({ $nulls: [...new Set(nulls)] });
      const now = new Date();
      const stamps = timestamps ? { created_at: cols.created_at ?? now, updated_at: cols.updated_at ?? now } : {};
      const all = serialId ? { ...cols } : { id: doc._id || doc.id || newId(), ...stamps, ...cols };
      const names = Object.keys(all);
      const sql =
        `INSERT INTO ${qi(table)} (${names.map(qi).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})` +
        `${onConflictDoNothing ? " ON CONFLICT DO NOTHING" : ""} RETURNING *`;
      const r = await (client || { query }).query(sql, Object.values(all));
      return fromRow(r.rows[0], { lean });
    },
    async insertMany(docs, opts) {
      const out = [];
      for (const d of docs) out.push(await repo.insert(d, opts));
      return out;
    },

    async updateOne(filter, patch, { sort, client, lean = false } = {}) {
      const params = [];
      const sets = buildSet(patch, params);
      if (!sets.length) return repo.findOne(filter, { sort, lean });
      const w = wherePart(filter, params);
      const sql = `UPDATE ${qi(table)} SET ${sets.join(", ")} WHERE id = (SELECT id FROM ${qi(table)}${w}${orderBy(sort)} LIMIT 1 FOR UPDATE) RETURNING *`;
      const r = await (client || { query }).query(sql, params);
      return fromRow(r.rows[0], { lean });
    },
    async updateById(id, patch, opts = {}) {
      return repo.updateOne({ _id: String(id) }, patch, opts);
    },
    async updateMany(filter, patch, { client } = {}) {
      const params = [];
      const sets = buildSet(patch, params);
      if (!sets.length) return 0;
      const r = await (client || { query }).query(
        `UPDATE ${qi(table)} SET ${sets.join(", ")}${wherePart(filter, params)}`,
        params
      );
      return r.rowCount;
    },
    async upsert(filter, patch, { client } = {}) {
      const existing = await repo.findOne(filter);
      if (existing) return repo.updateById(existing._id, patch, { client });
      const base = {};
      for (const [k, v] of Object.entries(filter))
        if (v === null || typeof v !== "object" || v instanceof Date) base[k] = v;
      return repo.insert({ ...base, ...patch }, { client });
    },
    async deleteById(id, { client, lean = false } = {}) {
      const r = await (client || { query }).query(`DELETE FROM ${qi(table)} WHERE id = $1 RETURNING *`, [String(id)]);
      return fromRow(r.rows[0], { lean });
    },
    async deleteMany(filter, { client } = {}) {
      const params = [];
      const r = await (client || { query }).query(`DELETE FROM ${qi(table)}${wherePart(filter, params)}`, params);
      return r.rowCount;
    },
  };
  return repo;
}

export { defineTable, prefix, snake, camel, qi };
