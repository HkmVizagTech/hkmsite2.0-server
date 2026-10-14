import { query, many } from "../db/pg.js";
import { CastError } from "./odm.js";

// Wraps a repo with the Mongoose behaviour of one model: cast/validate on writes, toJSON shaping on reads, and
// memory of explicit nulls. Mongo kept `field: null` apart from a missing field (a null does not get the schema
// default on read); a NULL column cannot, so the nulled paths live in `extra.$nulls`.
const NULLS = "$nulls";

// Lean reads that bypass the store (raw SQL rows) must not leak the bookkeeping key.
export const stripNulls = (doc) => {
  if (doc) delete doc[NULLS];
  return doc;
};

export function makeStore(repo, model) {
  const table = repo.table;
  const isNull = (v) => v === null;

  const decorate = async (docs, { lean = false, fields } = {}) => {
    const list = Array.isArray(docs) ? docs : [docs];
    const live = list.filter(Boolean);
    if (live.length) {
      const rows = await many(
        `SELECT id, extra->'${NULLS}' AS n FROM "${table}" WHERE id = ANY($1) AND extra ? '${NULLS}'`,
        [live.map((d) => d._id)]
      );
      const byId = new Map(rows.map((r) => [r.id, r.n]));
      for (const d of live) {
        if (lean) delete d[NULLS];
        for (const path of byId.get(d._id) || []) if (!fields || fields.includes(path)) d[path] = null;
      }
    }
    const out = lean ? list : list.map((d) => (d ? model.shape(d) : d));
    return Array.isArray(docs) ? out : out[0];
  };

  const recordNulls = async (id, patch) => {
    const keys = Object.keys(patch);
    const nulls = keys.filter((k) => isNull(patch[k]));
    const { rows } = await query(`SELECT extra->'${NULLS}' AS n FROM "${table}" WHERE id = $1`, [id]);
    if (!rows.length) return;
    const before = rows[0].n || [];
    if (!nulls.length && !before.length) return;
    const set = keys.filter((k) => !isNull(patch[k]));
    const after = [...new Set([...before.filter((p) => !set.includes(p)), ...nulls])];
    if (after.length === before.length && after.every((p) => before.includes(p))) return;
    if (after.length) {
      await query(
        `UPDATE "${table}" SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{${NULLS}}', $2::jsonb, true) WHERE id = $1`,
        [id, JSON.stringify(after)]
      );
    } else {
      await query(`UPDATE "${table}" SET extra = NULLIF(extra - '${NULLS}', '{}'::jsonb) WHERE id = $1`, [id]);
    }
  };

  return {
    repo,
    model,
    decorate,
    shape: (doc, { lean = false } = {}) => (doc && !lean ? model.shape(doc) : doc),

    async find(filter, opts = {}) {
      return decorate(await repo.find(filter, opts), opts);
    },
    async findOne(filter, opts = {}) {
      const doc = await repo.findOne(filter, opts);
      return doc ? decorate(doc, opts) : null;
    },
    async findById(id, opts = {}) {
      const doc = await repo.findById(id, opts);
      return doc ? decorate(doc, opts) : null;
    },

    // new Model(input).save(): cast + defaults + validators, then insert.
    async create(input, { client } = {}) {
      const cast = model.create(input);
      const doc = await repo.insert(cast, { client });
      if (Object.keys(cast).some((k) => isNull(cast[k]))) await recordNulls(doc._id, cast);
      return decorate(doc);
    },

    // findByIdAndUpdate(id, patch, { new: true }): cast only, no validators.
    async updateById(id, input, { client } = {}) {
      const cast = model.castUpdate(input);
      const doc = await repo.updateById(id, cast, { client });
      if (!doc) return null;
      await recordNulls(doc._id, cast);
      return decorate(doc);
    },

    // Persist already-cast changes (e.g. from model.applySave).
    async saveChanges(id, changes, { client } = {}) {
      const doc = await repo.updateById(id, changes, { client });
      if (!doc) return null;
      await recordNulls(doc._id, changes);
      return decorate(doc);
    },
  };
}

// ---- query-side casting (Query#cast) ----

export const castQueryId = (value, modelName, path = "_id") => {
  if (value === undefined || value === null) return value;
  const probe =
    value._id && value._id.toString instanceof Function
      ? value._id.toString()
      : value.toString instanceof Function
        ? value.toString()
        : value;
  if (typeof probe === "string" && /^[0-9a-f]{24}$/i.test(probe)) return probe.toLowerCase();
  throw new CastError("ObjectId", value, path, undefined, modelName);
};

// A req.query value used as an equality filter on a String path: arrays become $in, `$` operators work.
export const queryEq = (value, modelName, path) => {
  const str = (v) => {
    if (v == null) return v;
    if (v._id && typeof v._id === "string") return v._id;
    if (v.toString && v.toString !== Object.prototype.toString && !Array.isArray(v)) return v.toString();
    throw new CastError("string", v, path, undefined, modelName);
  };
  if (Array.isArray(value)) return { $in: value.map(str) };
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => k.startsWith("$"))) {
      const out = {};
      for (const [op, v] of Object.entries(value)) {
        if (["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(op)) out[op] = str(v);
        else if (op === "$in" || op === "$nin") out[op] = (Array.isArray(v) ? v : [v]).map(str);
        else if (op === "$exists") out[op] = !!v;
        else throw new Error(`Can't use ${op}`);
      }
      return out;
    }
  }
  return str(value);
};
