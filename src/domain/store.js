import { CastError } from "./odm.js";

// Wraps a repo with the Mongoose behaviour of one model: cast/validate on writes and the toJSON shaping
// (empty Mixed objects dropped) on reads.
export function makeStore(repo, model) {
  const shape = (doc, { lean = false } = {}) => (doc && !lean ? model.shape(doc) : doc);
  const shapeAll = (docs, opts) => docs.map((d) => shape(d, opts));

  return {
    repo,
    model,
    shape,
    shapeAll,

    async find(filter, opts = {}) {
      return shapeAll(await repo.find(filter, opts), opts);
    },
    async findOne(filter, opts = {}) {
      return shape(await repo.findOne(filter, opts), opts);
    },
    async findById(id, opts = {}) {
      return shape(await repo.findById(id, opts), opts);
    },

    // new Model(input).save(): cast + defaults + validators, then insert.
    async create(input, { client } = {}) {
      return shape(await repo.insert(model.create(input), { client }));
    },

    // findByIdAndUpdate(id, patch, { new: true }): cast only, no validators.
    async updateById(id, input, { client } = {}) {
      return shape(await repo.updateById(id, model.castUpdate(input), { client }));
    },

    // Persist already-cast changes (e.g. from model.applySave).
    async saveChanges(id, changes, { client } = {}) {
      return shape(await repo.updateById(id, changes, { client }));
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
