import { inspect } from "node:util";
import { newId } from "../db/pg.js";

// Mongoose casting/validation for the shop collections (product, shopCategory, shopSettings), reproduced
// so the Postgres port accepts, rejects and stores exactly what the Mongoose models did.

const HEX = /^[0-9a-f]{24}$/i;

const stringValue = (value) => {
  let s = inspect(value).replace(/^'|'$/g, '"');
  if (!s.startsWith('"')) s = `"${s}"`;
  return s;
};
const valueType = (value) => {
  if (value == null) return `${value}`;
  const t = typeof value;
  if (t !== "object") return t;
  return typeof value.constructor === "function" ? value.constructor.name : t;
};

class CastError extends Error {
  constructor(kind, value, path, reason, model) {
    let msg = `Cast to ${kind} failed for value ${stringValue(value)} (type ${valueType(value)}) at path "${path}"`;
    if (model) msg += ` for model "${model}"`;
    const rname = reason?.constructor?.name;
    if (rname && rname !== "AssertionError" && rname !== "Error") msg += ` because of "${rname}"`;
    super(msg);
    this.name = "CastError";
    this.kind = kind;
    this.path = path;
    this.reasonName = rname;
  }
}
class ObjectParameterError extends Error {}
class BSONError extends Error {}
class AssertionError extends Error {}

class ValidationError extends Error {
  constructor(model, errors) {
    super(`${model} validation failed: ${errors.map(([k, m]) => `${k}: ${m}`).join(", ")}`);
    this.name = "ValidationError";
  }
}

const castString = (value, path) => {
  if (value == null) return value;
  if (value._id && typeof value._id === "string") return value._id;
  if (value.toString && value.toString !== Object.prototype.toString && !Array.isArray(value)) return value.toString();
  throw new CastError("string", value, path);
};

const castNumber = (input, path) => {
  const value = input && input._id && typeof input._id !== "object" ? input._id : input;
  if (value == null) return value;
  if (value === "") return null;
  const fail = () => {
    throw new CastError("Number", value, path, new AssertionError());
  };
  let val = value;
  if (typeof val === "string" || typeof val === "boolean") val = Number(val);
  if (isNaN(val)) fail();
  if (typeof val === "number") return val;
  if (!Array.isArray(val) && typeof val.valueOf === "function") return Number(val.valueOf());
  if (val.toString && !Array.isArray(val) && val.toString() == Number(val)) return Number(val);
  return fail();
};

const BOOL_TRUE = new Set([true, "true", 1, "1", "yes"]);
const BOOL_FALSE = new Set([false, "false", 0, "0", "no"]);
const castBoolean = (value, path) => {
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  if (value == null) return value;
  throw new CastError("Boolean", value, path, new CastError("boolean", value, path));
};

// Mirrors cast/objectid.js followed by the bson ObjectId constructor (24 hex characters only).
const objectIdText = (value) => {
  if (value == null) return value;
  let v = value;
  if (v._id) v = v._id;
  const text = typeof v.toString === "function" ? v.toString() : v;
  return typeof text === "string" && HEX.test(text) ? text.toLowerCase() : undefined;
};
const castObjectId = (value, path) => {
  if (value == null) return value;
  const id = objectIdText(value);
  if (id === undefined) throw new CastError("ObjectId", value, path, new BSONError());
  return id;
};

// A value compared with an ObjectId path in a filter: null/undefined match null, arrays become $in, others are cast.
function idFilterValue(value, model, path) {
  const one = (v) => {
    if (v == null) return null;
    const id = looseObjectId(v);
    if (id === null) throw new CastError("ObjectId", v, path, null, model);
    return id;
  };
  if (Array.isArray(value)) return { $in: value.map(one) };
  return one(value);
}

// Used for ids in the URL: Mongoose throws a CastError mentioning the model.
const castIdParam = (value, model, path = "_id") => {
  if (typeof value !== "string" || !HEX.test(value)) throw new CastError("ObjectId", value, path, null, model);
  return value.toLowerCase();
};

// DocumentArray#id(): the id to look for, or null when it cannot be cast.
const looseObjectId = (value) => {
  try {
    return objectIdText(value) ?? null;
  } catch {
    return null;
  }
};

const applyString = (def, value, path) => {
  let v = value;
  if (def.trim) {
    if (typeof v !== "string") v = castString(v, path);
    return v ? v.trim() : v;
  }
  return castString(v, path);
};

const castStrings = (value, path) => {
  if (value == null) return value;
  const raw = Array.isArray(value) ? [...value] : [value];
  for (let i = 0; i < raw.length; i++) {
    try {
      raw[i] = castString(raw[i], `${path}.${i}`);
    } catch (e) {
      throw new CastError(`[${e.kind}]`, inspect(raw), `${path}.${i}`, e);
    }
  }
  return raw;
};

const VARIANT = [
  ["label", { t: "string", required: true, trim: true }],
  ["sku", { t: "string", trim: true }],
  ["price", { t: "number", required: true, min: 0 }],
  ["mrp", { t: "number", min: 0 }],
  ["stock", { t: "number", min: 0, default: 0 }],
  ["weightGrams", { t: "number" }],
];

const PRODUCT = {
  model: "product",
  paths: [
    ["name", { t: "string", required: true, trim: true }],
    ["slug", { t: "string", required: true }],
    ["shortDescription", { t: "string", trim: true }],
    ["description", { t: "string" }],
    ["productInfo", { t: "string", default: "" }],
    ["category", { t: "string" }],
    ["images", { t: "strings", default: [] }],
    ["hasVariants", { t: "boolean", default: false }],
    ["price", { t: "number", min: 0 }],
    ["mrp", { t: "number", min: 0 }],
    ["stock", { t: "number", min: 0, default: 0 }],
    ["variants", { t: "subdocs", schema: VARIANT, default: [] }],
    ["weightGrams", { t: "number" }],
    ["status", { t: "string", enum: ["active", "draft"], default: "draft" }],
    ["featured", { t: "boolean", default: false }],
    ["freeShipping", { t: "boolean", default: false }],
    ["tags", { t: "strings", default: [] }],
    ["sortOrder", { t: "number", default: 0 }],
    ["createdBy", { t: "objectid" }],
  ],
};

const CATEGORY = {
  model: "shopCategory",
  paths: [
    ["name", { t: "string", required: true, trim: true }],
    ["slug", { t: "string", required: true }],
    ["description", { t: "string", trim: true }],
    ["image", { t: "string" }],
    ["sortOrder", { t: "number", default: 0 }],
    ["status", { t: "string", enum: ["active", "hidden"], default: "active" }],
  ],
};

const SETTINGS = {
  model: "shopSettings",
  paths: [
    ["shopEnabled", { t: "boolean", default: true }],
    ["flatShippingCharge", { t: "number", default: 60 }],
    ["freeShippingAbove", { t: "number", default: 1000 }],
    ["announcement", { t: "string", trim: true }],
    ["supportMobile", { t: "string", trim: true }],
    ["deliveryEstimate", { t: "string", default: "Usually dispatched in 3–5 working days" }],
    ["updatedBy", { t: "objectid" }],
  ],
};

const castScalar = (def, value, path) => {
  switch (def.t) {
    case "string":
      return applyString(def, value, path);
    case "number":
      return castNumber(value, path);
    case "boolean":
      return castBoolean(value, path);
    case "objectid":
      return castObjectId(value, path);
    case "strings":
      return castStrings(value, path);
    default:
      throw new Error(`unsupported type ${def.t}`);
  }
};

const isObjectLike = (v) => v !== null && typeof v === "object";
const asList = (v) => (Array.isArray(v) ? v : v == null ? v : [v]);
const cloneDefault = (v) => (Array.isArray(v) ? [] : v);

// A variant subdocument as Mongoose builds it: cast errors are collected, not thrown.
function buildSubdoc(def, raw) {
  const castErrors = [];
  const values = {};
  const setOrder = [];
  const hasId = "_id" in raw && raw._id !== undefined;
  if (!hasId) values._id = newId();
  for (const [p, d] of def) {
    if (!(p in raw) || raw[p] === undefined) continue;
    try {
      values[p] = castScalar(d, raw[p], p);
      setOrder.push(p);
    } catch (e) {
      castErrors.push([p, e.message, e]);
    }
  }
  if (hasId) {
    try {
      values._id = castObjectId(raw._id, "_id");
    } catch (e) {
      castErrors.push(["_id", e.message, e]);
    }
  }
  for (const [p, d] of def) if (!(p in values) && !castErrors.some(([k]) => k === p) && "default" in d) values[p] = d.default;
  return { values, castErrors, setOrder };
}

const validateValue = (d, value, p) => {
  if (d.required && (value == null || (d.t === "string" && !value.length))) return `Path \`${p}\` is required.`;
  if (value == null) return null;
  if (d.min !== undefined && value < d.min) {
    return `Path \`${p}\` (${typeof value === "string" ? value : inspect(value)}) is less than minimum allowed value (${d.min}).`;
  }
  if (d.enum && !d.enum.includes(value)) {
    return `\`${typeof value === "string" ? value : inspect(value)}\` is not a valid enum value for path \`${p}\`.`;
  }
  return null;
};

function validationOrder(def, setPaths, invalid) {
  const required = def.filter(([p, d]) => d.required && !setPaths.includes(p) && !invalid.has(p)).map(([p]) => p).reverse();
  return [...required, ...setPaths.filter((p) => !invalid.has(p))];
}

function validateSubdoc(def, sub, prefix) {
  const errors = [];
  const invalid = new Set(sub.castErrors.map(([p]) => p));
  const order = validationOrder(def, sub.setOrder, invalid);
  for (const p of order) {
    const d = def.find(([k]) => k === p)[1];
    const msg = validateValue(d, sub.values[p], p);
    if (msg) errors.push([`${prefix}.${p}`, msg]);
  }
  return errors;
}

// `new Model(raw).save()`: returns the document to store, or throws a ValidationError with Mongoose's message.
function buildDocument(schema, raw) {
  const errors = [];
  const values = {};
  const setOrder = [];
  const invalid = new Set();
  const subdocs = new Map();

  for (const [p, d] of schema.paths) {
    if (!(p in raw) || raw[p] === undefined) continue;
    try {
      if (d.t === "subdocs") {
        const list = asList(raw[p]);
        if (list == null) values[p] = list;
        else {
          const built = [];
          subdocs.set(p, built);
          values[p] = built;
          list.forEach((el, i) => {
            if (el == null) return built.push(null);
            if (!isObjectLike(el)) throw new CastError("embedded", el, p, new ObjectParameterError());
            const sub = buildSubdoc(d.schema, el);
            sub.castErrors.forEach(([k, m]) => errors.push([`${p}.${i}.${k}`, m]));
            built.push(sub);
          });
        }
      } else values[p] = castScalar(d, raw[p], p);
      setOrder.push(p);
    } catch (e) {
      if (!(e instanceof CastError)) throw e;
      errors.push([e.path, e.message]);
      invalid.add(p);
    }
  }
  for (const [p, d] of schema.paths) {
    if (!(p in values) && !invalid.has(p) && "default" in d) values[p] = cloneDefault(d.default);
  }

  const deferred = [];
  for (const p of validationOrder(schema.paths, setOrder, invalid)) {
    const d = schema.paths.find(([k]) => k === p)[1];
    if (d.t === "subdocs") {
      (subdocs.get(p) || []).forEach((sub, i) => {
        if (sub) deferred.push(...validateSubdoc(d.schema, sub, `${p}.${i}`));
      });
      continue;
    }
    const msg = validateValue(d, values[p], p);
    if (msg) errors.push([p, msg]);
  }
  errors.push(...deferred);
  if (errors.length) throw new ValidationError(schema.model, errors);

  const doc = {};
  for (const [p, d] of schema.paths) {
    if (!(p in values)) continue;
    doc[p] = d.t === "subdocs" && Array.isArray(values[p]) ? values[p].map((sub) => (sub ? sub.values : null)) : values[p];
  }
  return doc;
}

// `findByIdAndUpdate(id, raw)`: casting only (no validators). The first key that fails to cast is reported;
// undefined values are dropped.
function castUpdate(schema, raw) {
  const out = {};
  for (const p of Object.keys(raw)) {
    const def = schema.paths.find(([k]) => k === p);
    if (!def || raw[p] === undefined) continue;
    const d = def[1];
    if (d.t === "subdocs") {
      const list = asList(raw[p]);
      out[p] = list == null ? list : list.map((el) => {
        if (!el) return el;
        if (!isObjectLike(el)) throw new CastError("embedded", el, p, new ObjectParameterError());
        const sub = buildSubdoc(d.schema, el);
        if (sub.castErrors.length) throw new CastError("embedded", el, p, sub.castErrors[0][2]);
        return sub.values;
      });
    } else out[p] = castScalar(d, raw[p], p);
  }
  return out;
}

// Mongoose turns a filter value on a String path into a query condition: arrays become $in, operator objects
// have their operands cast, anything else must be castable to a string.
const OPERAND_ONE = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]);
function queryValue(value, path, model) {
  const fail = (v) => new CastError("string", v, path, null, model);
  const one = (v) => {
    if (v == null) return v;
    try {
      return castString(v, path);
    } catch {
      throw fail(v);
    }
  };
  // Postgres text cannot hold NUL, so nothing stored can equal such a value.
  const noNul = (list) => list.filter((v) => typeof v !== "string" || !v.includes("\0"));
  if (Array.isArray(value)) return { $in: noNul(value.map(one)) };
  if (typeof value === "string" && value.includes("\0")) return { $in: [] };
  if (value === null || typeof value !== "object") return one(value);
  const keys = Object.keys(value);
  if (!keys.length || !keys.every((k) => k.startsWith("$"))) throw fail(value);
  const out = {};
  for (const [op, v] of Object.entries(value)) {
    if (op === "$in" || op === "$nin") out[op] = noNul((Array.isArray(v) ? v : [v]).map(one));
    else if (OPERAND_ONE.has(op)) out[op] = one(v);
    else if (op === "$exists" || op === "$regex" || op === "$options") out[op] = v;
    else throw new Error(`Can't use ${op} with String.`);
  }
  return out;
}

export {
  idFilterValue,
  queryValue,
  CastError,
  ValidationError,
  PRODUCT,
  CATEGORY,
  SETTINGS,
  buildDocument,
  castUpdate,
  castIdParam,
  looseObjectId,
  castString,
  castNumber,
};
