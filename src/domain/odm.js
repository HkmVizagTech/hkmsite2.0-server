import util from "node:util";
import { newId } from "../db/pg.js";

// A small re-implementation of the parts of Mongoose that shaped request/response behaviour:
// casting, setters (trim/lowercase), defaults, validators and their messages, update casting.

export const ObjectId = Symbol("ObjectId");
export const Mixed = Symbol("Mixed");
export const sub = (def, opts = {}) => ({ __sub: true, def, ...opts });

export class CastError extends Error {
  constructor(kind, value, path, reason, model) {
    const stringValue = inspectValue(value);
    const type = valueType(value);
    let msg = `Cast to ${kind} failed for value ${stringValue} (type ${type}) at path "${path}"`;
    if (model) msg += ` for model "${model}"`;
    const rname = reason?.constructor?.name;
    if (reason != null && typeof reason.constructor === "function" && rname !== "AssertionError" && rname !== "Error") {
      msg += ` because of "${rname}"`;
    }
    super(msg);
    this.name = "CastError";
    this.kind = kind;
    this.value = value;
    this.path = path;
    this.reason = reason;
  }
}

export class ValidationError extends Error {
  constructor(modelName, errors) {
    super(`${modelName} validation failed: ${[...errors].map(([k, m]) => `${k}: ${m}`).join(", ")}`);
    this.name = "ValidationError";
    this.errors = Object.fromEntries(errors);
  }
}

class ObjectParameterError extends Error {
  constructor() {
    super("ObjectParameterError");
    this.name = "ObjectParameterError";
  }
}

function inspectValue(value) {
  let s = util.inspect(value);
  s = s.replace(/^'|'$/g, '"');
  if (!s.startsWith('"')) s = '"' + s + '"';
  return s;
}
function valueType(v) {
  if (v == null) return "" + v;
  const t = typeof v;
  if (t !== "object") return t;
  if (typeof v.constructor !== "function") return t;
  return v.constructor.name;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NO_VALUE = Symbol("none");

// ---- scalar casts (same rules as Mongoose's lib/cast/*) ----
const castStringRaw = (value) => {
  if (value == null) return value;
  if (value._id && typeof value._id === "string") return value._id;
  if (value.toString && value.toString !== Object.prototype.toString && !Array.isArray(value)) return value.toString();
  throw new Error("cast");
};
const castNumberRaw = (val) => {
  if (val == null) return val;
  if (val === "") return null;
  if (typeof val === "string" || typeof val === "boolean") val = Number(val);
  if (isNaN(val)) throw new Error("assert");
  if (typeof val === "number") return val;
  if (!Array.isArray(val) && typeof val.valueOf === "function") return Number(val.valueOf());
  if (val.toString && !Array.isArray(val) && val.toString() == Number(val)) return Number(val);
  throw new Error("assert");
};
const TRUE = new Set([true, "true", 1, "1", "yes"]);
const FALSE = new Set([false, "false", 0, "0", "no"]);
const castBooleanRaw = (value) => {
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  if (value == null) return value;
  throw new Error("cast");
};
const castDateRaw = (value) => {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new Error("assert");
    return value;
  }
  let date;
  if (typeof value === "boolean") throw new Error("assert");
  if (typeof value === "number") date = new Date(value);
  else if (
    typeof value === "string" &&
    !Number.isNaN(Number(value)) &&
    (Number(value) >= 275761 || Number(value) < -271820)
  )
    date = new Date(Number(value));
  else if (typeof value.valueOf === "function") date = new Date(value.valueOf());
  else date = new Date(value);
  if (!Number.isNaN(date.valueOf())) return date;
  throw new Error("assert");
};
const HEX24 = /^[0-9a-f]{24}$/i;
export const toObjectIdString = (value) => {
  if (typeof value === "string" && HEX24.test(value)) return value.toLowerCase();
  throw new Error("BSONError");
};
const castObjectIdRaw = (value) => {
  if (value == null) return value;
  if (value._id && value._id.toString instanceof Function) return toObjectIdString(value._id.toString());
  if (value.toString instanceof Function) return toObjectIdString(value.toString());
  return toObjectIdString(value);
};

const KIND_NAMES = { String: "string", Number: "Number", Boolean: "Boolean", Date: "date", ObjectId: "ObjectId" };
const RAW_CASTS = {
  String: castStringRaw,
  Number: castNumberRaw,
  Boolean: castBooleanRaw,
  Date: castDateRaw,
  ObjectId: castObjectIdRaw,
};
class BSONError extends Error {}
class CastErrorReason extends Error {}
Object.defineProperty(CastErrorReason, "name", { value: "CastError" });
const reasonFor = (kind, err) => {
  if (kind === "ObjectId") return new BSONError("bson");
  if (kind === "Boolean") return new CastErrorReason("cast");
  if (kind === "Number" || kind === "Date") return err;
  return undefined;
};

// ---- schema compilation ----
const typeOf = (t) => {
  if (t === String) return "String";
  if (t === Number) return "Number";
  if (t === Boolean) return "Boolean";
  if (t === Date) return "Date";
  if (t === ObjectId) return "ObjectId";
  if (t === Mixed || t === Object) return "Mixed";
  return null;
};

const compileSchema = (def, { _id = true, name = "" } = {}) => {
  const schema = { paths: new Map(), nested: new Set(), _id, name };
  const walk = (obj, prefix) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix + key;
      define(path, value);
    }
  };
  const define = (path, value) => {
    // plain nested object without a `type`
    if (
      isObj(value) &&
      !value.__sub &&
      !("type" in value && (typeOf(value.type) || Array.isArray(value.type) || value.type?.__sub))
    ) {
      schema.nested.add(path);
      walk(value, path + ".");
      return;
    }
    let opts;
    let t;
    if (isObj(value) && !value.__sub) {
      ({ type: t, ...opts } = value);
    } else {
      t = value;
      opts = {};
    }
    if (Array.isArray(t)) {
      const [inner] = t;
      const p = { path, kind: "Array", opts };
      if (inner && (inner.__sub || (isObj(inner) && !("type" in inner && typeOf(inner.type))))) {
        const subDef = inner.__sub ? inner.def : inner;
        p.kind = "DocArray";
        p.sub = compileSchema(subDef, { _id: inner.__sub ? inner._id !== false : true });
      } else {
        let ielem = inner;
        let eopts = {};
        if (isObj(inner) && !inner.__sub) ({ type: ielem, ...eopts } = inner);
        p.elem = { path, kind: typeOf(ielem) || "Mixed", opts: eopts };
      }
      schema.paths.set(path, p);
      return;
    }
    if (t && t.__sub) {
      throw new Error("single nested subdocuments are not supported");
    }
    schema.paths.set(path, { path, kind: typeOf(t) || "Mixed", opts });
  };
  walk(def, "");
  return schema;
};

const applySetters = (opts, v) => {
  if (typeof v !== "string") return v;
  if (opts.lowercase) v = v.toLowerCase();
  if (opts.uppercase) v = v.toUpperCase();
  if (opts.trim) v = v.trim();
  return v;
};

// Casts one scalar for path `p`. Throws CastError (without model name).
const castScalar = (p, value, path = p.path) => {
  if (p.kind === "Mixed") return value;
  const raw = RAW_CASTS[p.kind];
  let out;
  if (p.kind === "Number" && value && typeof value._id !== "undefined") value = value._id;
  try {
    out = raw(value);
  } catch (err) {
    throw new CastError(KIND_NAMES[p.kind], value, path, reasonFor(p.kind, err));
  }
  return p.kind === "String" ? applySetters(p.opts, out) : out;
};

const emptyToNull = (p, doc) => (!p.sub._id && isObj(doc) && Object.keys(doc).length === 0 ? null : doc);
const castDocElement = (p, value, arrayPath, index, sink) => {
  if (!value) return value;
  const out = castDocElementRaw(p, value, arrayPath, index, sink);
  return emptyToNull(p, out);
};
const castDocElementRaw = (p, value, arrayPath, index, sink) => {
  if (typeof value !== "object") throw new CastError("embedded", value, arrayPath, new ObjectParameterError());
  if (sink) return buildSubdoc(p.sub, value, (e) => sink.set(`${arrayPath}.${index}.${e.path}`, e.message));
  try {
    return buildSubdoc(p.sub, value, (e) => {
      throw e;
    });
  } catch (err) {
    throw new CastError("embedded", value, arrayPath, err);
  }
};

const castArray = (p, value, path = p.path, sink = null) => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (p.kind === "DocArray") return list.map((el, i) => castDocElement(p, el, path, i, sink));
  const view = list.slice();
  let i = 0;
  try {
    const out = [];
    for (; i < list.length; i++) {
      out.push(castScalar(p.elem, list[i], `${path}.${i}`));
      view[i] = out[i];
    }
    return out;
  } catch (err) {
    const shown = i > 0 && list[0] === null ? "<Revoked Proxy>" : util.inspect(view);
    throw new CastError(`[${err.kind}]`, shown, `${path}.${i}`, err);
  }
};

const defaultOf = (p) => {
  const v = rawDefault(p);
  return p.kind === "Date" && typeof v === "number" ? new Date(v) : v;
};
const rawDefault = (p) => {
  if (p.kind === "Array" || p.kind === "DocArray") {
    if ("default" in p.opts) return typeof p.opts.default === "function" ? p.opts.default() : p.opts.default;
    return [];
  }
  if (!("default" in p.opts)) return undefined;
  return typeof p.opts.default === "function" ? p.opts.default() : p.opts.default;
};

// Builds a subdocument: casts and applies defaults. `onError` receives CastErrors (update: throws; create: records).
function buildSubdoc(schema, input, onError) {
  const doc = {};
  if (schema._id) {
    if (isObj(input) && input._id !== undefined && input._id !== null) {
      try {
        doc._id = castObjectIdRaw(input._id);
      } catch (_) {
        onError(new CastError("ObjectId", input._id, "_id", new BSONError("bson")));
        doc._id = newId();
      }
    } else doc._id = newId();
  }
  const src = Array.isArray(input) ? {} : input;
  for (const [path, p] of schema.paths) {
    let v = getInput(src, path);
    if (v === undefined) v = defaultOf(p);
    else {
      try {
        v = p.kind === "Array" || p.kind === "DocArray" ? castArray(p, v) : castScalar(p, v);
      } catch (err) {
        onError(err);
        continue;
      }
    }
    if (v !== undefined) setPath(doc, path, v);
  }
  return doc;
}

const setPath = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
};
const getPath = (obj, path) => {
  let o = obj;
  for (const k of path.split(".")) {
    if (!isObj(o) || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
    o = o[k];
  }
  return o;
};
const getInput = (src, path) => (Object.prototype.hasOwnProperty.call(src, path) ? src[path] : getPath(src, path));

// Mongoose "minimize": empty plain objects are dropped on save/toJSON.
const minimize = (v) => {
  if (!isObj(v) || v instanceof Date) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const m = minimize(x);
    if (isObj(m) && !(m instanceof Date) && Object.keys(m).length === 0) continue;
    out[k] = m;
  }
  return out;
};
const minimizeMixed = (v) => {
  const m = minimize(v);
  return isObj(m) && !(m instanceof Date) && Object.keys(m).length === 0 ? undefined : m;
};

// ---- validators ----
const checkRequired = (p, v) => {
  switch (p.kind) {
    case "String":
      return typeof v === "string" && v.length > 0;
    case "Number":
      return typeof v === "number";
    case "Boolean":
      return typeof v === "boolean";
    case "Date":
      return v instanceof Date;
    case "Array":
    case "DocArray":
      return Array.isArray(v) && v.length > 0;
    default:
      return v != null;
  }
};

const validatePath = (p, v, path = p.path) => {
  const o = p.opts;
  if (o.required && !checkRequired(p, v)) return `Path \`${path}\` is required.`;
  if (v === undefined) return null;
  if (o.enum && p.kind === "String" && v !== null && !o.enum.includes(v)) {
    return `\`${v}\` is not a valid enum value for path \`${path}\`.`;
  }
  if (v === null) return null;
  if (o.min !== undefined && typeof v === "number" && v < o.min)
    return `Path \`${path}\` (${v}) is less than minimum allowed value (${o.min}).`;
  if (o.max !== undefined && typeof v === "number" && v > o.max)
    return `Path \`${path}\` (${v}) is more than maximum allowed value (${o.max}).`;
  if (o.maxlength !== undefined && typeof v === "string" && v.length > o.maxlength)
    return `Path \`${path}\` (\`${v}\`) is longer than the maximum allowed length (${o.maxlength}).`;
  return null;
};

const validateSubdocs = (schema, docs, basePath, errors) => {
  docs.forEach((d, i) => {
    if (!d) return;
    const all = [...schema.paths];
    const unsetRequired = all.filter(([path, p]) => p.opts.required && getPath(d, path) === undefined).reverse();
    const rest = all.filter(([path, p]) => !(p.opts.required && getPath(d, path) === undefined));
    for (const [path, p] of [...unsetRequired, ...rest]) {
      const v = getPath(d, path);
      const full = `${basePath}.${i}.${path}`;
      if (errors.has(full)) continue;
      if (p.kind === "DocArray") {
        if (Array.isArray(v)) validateSubdocs(p.sub, v, full, errors);
        continue;
      }
      const msg = validatePath(p, v, path);
      if (msg) errors.set(full, msg);
    }
  });
};

export function defineModel(name, def, { timestamps = true } = {}) {
  const schema = compileSchema(def, { name });
  // `_id` and the timestamps are ordinary paths on create (a body may carry them), never on update.
  const meta = (path, kind) => [path, { path, kind, opts: { meta: true } }];
  schema.paths = new Map([
    ...schema.paths,
    meta("_id", "ObjectId"),
    ...(timestamps ? [meta("createdAt", "Date"), meta("updatedAt", "Date")] : []),
  ]);
  const requiredPaths = [...schema.paths.values()].filter((p) => p.opts.required).reverse();

  // `new Model(input)` + validate. Throws ValidationError with Mongoose's message.
  const create = (input = {}) => {
    const errors = new Map();
    const doc = {};
    const modified = [];
    const castFailed = new Set();
    const src = isObj(input) ? input : {};
    const nullNested = [...schema.nested].filter(
      (n) => Object.prototype.hasOwnProperty.call(src, n) && src[n] === null
    );
    for (const n of nullNested) setPath(doc, n, null);
    const suppressed = [...schema.nested].filter(
      (n) => Object.prototype.hasOwnProperty.call(src, n) && src[n] !== undefined && !isObj(src[n])
    );
    const literalDotted = (path) => Object.prototype.hasOwnProperty.call(src, path) && path.includes(".");
    const assignOrder = [...schema.paths].sort(([a], [b]) => Number(literalDotted(a)) - Number(literalDotted(b)));
    for (const [path, p] of assignOrder) {
      let v = getInput(src, path);
      if (v === undefined) {
        // `{ path: undefined }` marks the path as set (validated in set order), unlike a missing key.
        if (Object.prototype.hasOwnProperty.call(src, path)) modified.push(path);
        continue;
      }
      try {
        v = p.kind === "Array" || p.kind === "DocArray" ? castArray(p, v, p.path, errors) : castScalar(p, v);
      } catch (err) {
        errors.set(err.path ?? path, err.message);
        castFailed.add(path);
        continue;
      }
      if (v !== undefined) {
        setPath(doc, path, v);
        modified.push(path);
      }
    }
    const defaults = [];
    for (const [path, p] of schema.paths) {
      if (castFailed.has(path) || getPath(doc, path) !== undefined || getInput(src, path) !== undefined) continue;
      if (suppressed.some((n) => path.startsWith(n + "."))) continue;
      const dv = defaultOf(p);
      if (dv !== undefined) {
        setPath(doc, path, p.kind === "DocArray" ? dv.map((d) => buildSubdoc(p.sub, d, () => {})) : dv);
        defaults.push(path);
      }
    }
    const order = [
      ...new Set([
        ...requiredPaths.map((p) => p.path).filter((x) => !castFailed.has(x) && !modified.includes(x)),
        ...modified,
        ...defaults,
      ]),
    ];
    const elemPaths = [];
    for (const path of order) {
      if (castFailed.has(path)) continue;
      const p = schema.paths.get(path);
      const msg = validatePath(p, getPath(doc, path));
      if (msg) errors.set(path, msg);
      if (p.kind === "Array" && p.elem.opts.required && Array.isArray(getPath(doc, path))) elemPaths.push(p);
    }
    for (const p of elemPaths) {
      getPath(doc, p.path).forEach((el, i) => {
        const msg = validatePath(p.elem, el, `${p.path}.${i}`);
        if (msg) errors.set(`${p.path}.${i}`, msg);
      });
    }
    for (const p of schema.paths.values()) {
      if (p.kind !== "DocArray" || castFailed.has(p.path)) continue;
      const v = getPath(doc, p.path);
      if (Array.isArray(v)) validateSubdocs(p.sub, v, p.path, errors);
    }
    if (errors.size) throw new ValidationError(name, errors);
    for (const p of schema.paths.values()) {
      if (p.kind === "Mixed") {
        const v = getPath(doc, p.path);
        if (v !== undefined) {
          const m = minimizeMixed(v);
          if (m === undefined) removePath(doc, p.path);
          else setPath(doc, p.path, m);
        }
      }
    }
    return doc;
  };

  // findByIdAndUpdate(id, patch) casting: strict, no validators, undefined skipped.
  const castUpdate = (patch = {}) => {
    const out = {};
    for (const [key, raw] of Object.entries(isObj(patch) ? patch : {})) {
      if (raw === undefined) continue;
      const p = schema.paths.get(key);
      if (p?.opts.meta) continue;
      if (p) {
        out[key] = castForUpdate(p, raw);
        continue;
      }
      if (schema.nested.has(key)) {
        Object.assign(out, castNested(key, raw));
      }
    }
    return out;
  };
  const castForUpdate = (p, raw) => {
    if (raw === null) return null;
    if (p.kind === "Array" || p.kind === "DocArray") return castArray(p, raw);
    return castScalar(p, raw);
  };
  // `$set: { nested: value }` replaces the nested object, casting known keys only.
  const castNested = (prefix, raw) => {
    if (!isObj(raw)) return { [prefix]: raw };
    const walk = (pre, src) => {
      const obj = {};
      for (const key of Object.keys(src).reverse()) {
        const full = `${pre}.${key}`;
        const p = schema.paths.get(full);
        if (p) obj[key] = castForUpdate(p, src[key]);
        else if (schema.nested.has(full)) obj[key] = walk(full, isObj(src[key]) ? src[key] : {});
      }
      return obj;
    };
    return { [prefix]: walk(prefix, raw) };
  };

  // existing.save() after `Object.assign(existing, patch)`: cast, track real changes, validate the whole document.
  const applySave = (existing, assignments) => {
    const errors = new Map();
    const next = structuredCloneDoc(existing);
    const modified = {};
    const castFailed = new Set();
    const assign = (path, raw) => {
      const p = schema.paths.get(path);
      if (p?.opts.meta) return;
      if (!p) {
        if (schema.nested.has(path) && isObj(raw)) {
          for (const [k, v] of Object.entries(raw)) assign(`${path}.${k}`, v);
        }
        return;
      }
      let v;
      try {
        v =
          raw === null
            ? null
            : p.kind === "Array" || p.kind === "DocArray"
              ? castArray(p, raw, p.path, errors)
              : castScalar(p, raw);
      } catch (err) {
        errors.set(err.path ?? path, err.message);
        castFailed.add(path);
        return;
      }
      if (v === undefined) return;
      if (!deepEqual(v, getPath(next, path))) {
        setPath(next, path, v);
        modified[path] = v;
      }
    };
    for (const [k, v] of Object.entries(assignments)) assign(k, v);
    const order = [...schema.paths.values()];
    const touched = new Set(Object.keys(modified));
    const unsetRequired = order.filter((x) => x.opts.required && getPath(next, x.path) === undefined).reverse();
    const sequence = [
      ...unsetRequired,
      ...order.filter((x) => !touched.has(x.path)),
      ...Object.keys(modified).map((k) => schema.paths.get(k)),
    ];
    for (const p of sequence) {
      if (castFailed.has(p.path) || errors.has(p.path)) continue;
      if (p.kind === "DocArray") continue;
      const msg = validatePath(p, getPath(next, p.path));
      if (msg) errors.set(p.path, msg);
      if (p.kind === "Array" && p.elem.opts.required && Array.isArray(getPath(next, p.path))) {
        getPath(next, p.path).forEach((el, i) => {
          const m = validatePath(p.elem, el, `${p.path}.${i}`);
          if (m) errors.set(`${p.path}.${i}`, m);
        });
      }
    }
    if (errors.size) throw new ValidationError(name, errors);
    return { doc: next, modified };
  };

  // What Mongoose's toJSON did: drop empty Mixed objects, turn empty id-less subdocuments into null.
  const shape = (doc) => {
    if (!doc) return doc;
    const out = { ...doc };
    for (const p of schema.paths.values()) {
      if (p.path.includes(".")) continue;
      const v = out[p.path];
      if (v === undefined) continue;
      if (p.kind === "Mixed") {
        const m = minimizeMixed(v);
        if (m === undefined) delete out[p.path];
        else out[p.path] = m;
      } else if (p.kind === "DocArray" && Array.isArray(v)) out[p.path] = v.map((d) => emptyToNull(p, d));
    }
    return out;
  };

  const hasPath = (key) => schema.paths.has(key) || schema.nested.has(key);
  return {
    name,
    schema,
    create,
    castUpdate,
    applySave,
    shape,
    hasPath,
    timestamps,
    castScalarPath: (path, v) => castForUpdate(schema.paths.get(path), v),
  };
}

const structuredCloneDoc = (v) => {
  if (v instanceof Date) return new Date(v);
  if (Array.isArray(v)) return v.map(structuredCloneDoc);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneDoc(x)]));
  return v;
};
export const deepEqual = (a, b) => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return a === b;
};

const removePath = (obj, path) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (cur == null) return;
  }
  delete cur[parts[parts.length - 1]];
};

// `findByIdAndUpdate(id, <array>)` was an aggregation-pipeline update in MongoDB; these are the errors it raised.
const PIPELINE_STAGES = ["$addFields", "$set", "$project", "$unset", "$replaceRoot", "$replaceWith"];
export const pipelineBodyError = (body) => {
  if (!Array.isArray(body)) return null;
  for (const el of body) {
    if (el === null || el === undefined) return new Error("Cannot convert undefined or null to object");
    if (typeof el !== "object" || Array.isArray(el))
      return new Error("Each element of the 'pipeline' array must be an object");
    const keys = Object.keys(el);
    if (keys.length !== 1) return new Error("A pipeline stage specification object must contain exactly one field.");
    if (!PIPELINE_STAGES.includes(keys[0])) return new Error(`Invalid update pipeline operator: "${keys[0]}"`);
  }
  return null;
};
