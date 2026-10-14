import util from "node:util";
import { isId } from "../db/pg.js";

// Reproduces how Mongoose cast and validated values for the donation schema (messages included).

const stringValue = (v) => {
  let s = util.inspect(v).replace(/^'|'$/g, '"');
  if (!s.startsWith('"')) s = `"${s}"`;
  return s;
};
const valueType = (v) => {
  if (v == null) return String(v);
  if (typeof v !== "object") return typeof v;
  return typeof v.constructor === "function" ? v.constructor.name : "object";
};

export function castError(kind, value, path, { model, because } = {}) {
  const err = new Error(
    `Cast to ${kind} failed for value ${stringValue(value)} (type ${valueType(value)}) at path "${path}"` +
      (model ? ` for model "${model}"` : "") +
      (because ? ` because of "${because}"` : "")
  );
  err.name = "CastError";
  return err;
}

const TRUE = new Set([true, "true", 1, "1", "yes"]);
const FALSE = new Set([false, "false", 0, "0", "no"]);

const castString = (v, path, opts) => {
  if (v == null) return v;
  if (typeof v === "object") throw castError("string", v, path, opts);
  return String(v);
};
const castNumber = (v, path, opts) => {
  if (v == null) return v;
  if (v === "") return null;
  if (typeof v === "object") throw castError("Number", v, path, opts);
  const n = typeof v === "string" || typeof v === "boolean" ? Number(v) : v;
  if (Number.isNaN(n)) throw castError("Number", v, path, opts);
  return n;
};
const castBoolean = (v, path, opts) => {
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  if (v == null) return v;
  throw castError("boolean", v, path, { ...opts, because: opts?.because ?? "CastError" });
};
const castDate = (v, path, opts) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.valueOf())) throw castError("date", v, path, opts);
    return v;
  }
  if (typeof v === "boolean") throw castError("date", v, path, opts);
  const d =
    typeof v === "number"
      ? new Date(v)
      : typeof v === "string" && !Number.isNaN(Number(v)) && (Number(v) >= 275761 || Number(v) < -271820)
        ? new Date(Number(v))
        : new Date(v.valueOf());
  if (Number.isNaN(d.valueOf())) throw castError("date", v, path, opts);
  return d;
};
const castObjectId = (v, path, opts) => {
  if (v == null) return v;
  let x = v;
  if (typeof x === "object" && !Array.isArray(x) && x._id != null) x = x._id;
  if (Array.isArray(x)) x = String(x);
  if (typeof x === "string" && isId(x)) return x;
  throw castError("ObjectId", v, path, opts);
};

export const castId = (id, model = "donation", path = "_id") => castObjectId(id, path, { model });

const CASTERS = { string: castString, number: castNumber, boolean: castBoolean, date: castDate, oid: castObjectId };

// Donation schema paths in declaration order (cast errors are reported in this order).
const S = (extra = {}) => ({ t: "string", ...extra });
const DONATION_PATHS = {
  donorName: S({ required: true }),
  donorEmail: S(),
  donorMobile: S(),
  amount: { t: "number", required: true },
  date: { t: "date" },
  type: S(),
  status: S({ enum: ["pending", "active", "completed", "failed", "cancelled"] }),
  message: S(),
  sourcePage: S(),
  sevaName: S(),
  transactionId: S(),
  festivalId: { t: "oid" },
  festivalSlug: S(),
  dccEnrolledById: { t: "number" },
  panNumber: S(),
  certificate: { t: "boolean" },
  sevakName: S(),
  sevaDate: S(),
  dob: S(),
  wantPrasadam: { t: "boolean" },
  "prasadamAddress.doorNo": S(),
  "prasadamAddress.house": S(),
  "prasadamAddress.street": S(),
  "prasadamAddress.area": S(),
  "prasadamAddress.country": S(),
  "prasadamAddress.state": S(),
  "prasadamAddress.city": S(),
  "prasadamAddress.pincode": S(),
  prasadamStatus: S({ enum: ["pending", "dispatched", "delivered", "cancelled"], trim: false }),
  prasadamCourier: S({ trim: true }),
  prasadamTrackingNumber: S({ trim: true }),
  prasadamDispatchedAt: { t: "date" },
  prasadamDeliveredAt: { t: "date" },
  prasadamNotes: S({ trim: true }),
  razorpayOrderId: S(),
  razorpayPaymentId: S(),
  manualEntry: { t: "boolean" },
  utrNumber: S({ trim: true }),
  manualPaymentMode: S({ enum: ["upi", "bank", "cash", "cheque"] }),
  manualEntryNote: S({ trim: true }),
  manualEnteredBy: { t: "oid" },
  donorRecordId: { t: "oid" },
  donorId: S(),
  createdBy: { t: "oid" },
};

const ADDRESS_KEYS = ["doorNo", "house", "street", "area", "country", "state", "city", "pincode"];

const castPath = (spec, value, path, opts) => {
  let v = CASTERS[spec.t](value, path, opts);
  if (spec.trim && typeof v === "string") v = v.trim();
  return v;
};

// Values as stored by new Model(input).save(): cast, then required/enum validation (message format of ValidationError).
export function castDonationForCreate(input, { model = "donation" } = {}) {
  const out = {};
  const errors = [];
  const flat = { ...input };
  const addr = input.prasadamAddress;
  const addrObj = addr && typeof addr === "object" && !Array.isArray(addr) ? addr : null;
  for (const k of ADDRESS_KEYS) if (addrObj && addrObj[k] !== undefined) flat[`prasadamAddress.${k}`] = addrObj[k];

  const failed = new Set();
  for (const [path, spec] of Object.entries(DONATION_PATHS)) {
    if (flat[path] === undefined) continue;
    try {
      const v = castPath(spec, flat[path], path, { because: spec.t === "oid" ? "BSONError" : undefined });
      if (v !== undefined) out[path] = v;
    } catch (e) {
      failed.add(path);
      errors.push(`${path}: ${e.message}`);
    }
  }
  for (const [path, spec] of Object.entries(DONATION_PATHS)) {
    if (failed.has(path)) continue;
    const v = out[path];
    if (spec.required && (v === undefined || v === null || v === ""))
      errors.push(`${path}: Path \`${path}\` is required.`);
    if (spec.enum && v != null && !spec.enum.includes(v))
      errors.push(`${path}: \`${v}\` is not a valid enum value for path \`${path}\`.`);
  }
  if (errors.length) {
    const err = new Error(`${model} validation failed: ${errors.join(", ")}`);
    err.name = "ValidationError";
    throw err;
  }

  const doc = {};
  for (const [path, v] of Object.entries(out)) {
    if (path.startsWith("prasadamAddress.")) (doc.prasadamAddress ||= {})[path.slice(16)] = v;
    else doc[path] = v;
  }
  return doc;
}

// Values as stored by findByIdAndUpdate(id, update): casting and setters only, no validators.
export function castDonationForUpdate(input) {
  const doc = {};
  for (const [path, spec] of Object.entries(DONATION_PATHS)) {
    if (path.startsWith("prasadamAddress.")) continue;
    if (input[path] === undefined) continue;
    const v = castPath(spec, input[path], path);
    if (v !== undefined) doc[path] = v;
  }
  if (input.prasadamAddress !== undefined) {
    const a = input.prasadamAddress;
    const supplied = {};
    if (a && typeof a === "object" && !Array.isArray(a)) {
      for (const k of ADDRESS_KEYS) {
        if (a[k] === undefined) continue;
        const v = castString(a[k], `prasadamAddress.${k}`);
        if (v !== undefined) supplied[k] = v;
      }
    }
    // Mongoose replaces the whole sub-object: keys that were not supplied disappear.
    doc.prasadamAddress = supplied;
    doc.$unset = ADDRESS_KEYS.filter((k) => !(k in supplied)).map((k) => `prasadamAddress.${k}`);
  }
  return doc;
}

// Query casting (find/count/updateOne filters). Paths not listed are not cast.
const FILTER_TYPES = {
  _id: "oid",
  festivalId: "oid",
  donorRecordId: "oid",
  manualEnteredBy: "oid",
  amount: "number",
  date: "date",
  createdAt: "date",
  updatedAt: "date",
  certificate: "boolean",
  wantPrasadam: "boolean",
  isRecurring: "boolean",
  manualEntry: "boolean",
};
const typeOfPath = (path) => FILTER_TYPES[path] || "string";

function castFilterValue(type, v, path, model) {
  if (v instanceof RegExp) return v;
  return CASTERS[type](v, path, { model });
}

// Returns a filter the repos understand: arrays on scalar paths become $in (as in Mongoose); throws what Mongoose threw.
export function castFilter(filter, { model = "donation", types = {} } = {}) {
  const walk = (f) => {
    const out = {};
    for (const [key, cond] of Object.entries(f)) {
      if (key === "$or" || key === "$and" || key === "$nor") {
        out[key] = cond.map(walk);
        continue;
      }
      if (key.startsWith("$") || cond === undefined) {
        out[key] = cond;
        continue;
      }
      const type = types[key] || typeOfPath(key);
      if (Array.isArray(cond)) {
        out[key] = { $in: cond.map((x) => castFilterValue(type, x, key, model)) };
        continue;
      }
      if (cond && typeof cond === "object" && !(cond instanceof RegExp) && !(cond instanceof Date)) {
        const ops = Object.keys(cond);
        if (ops.length && ops.every((o) => o.startsWith("$"))) {
          for (const [op, v] of Object.entries(cond)) {
            if (op === "$in" || op === "$nin") v.forEach((x) => castFilterValue(type, x, key, model));
            else if (op === "$regex") {
              if (!(v instanceof RegExp)) castString(v, key, { model });
            } else if (["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(op)) castFilterValue(type, v, key, model);
          }
          out[key] = cond;
          continue;
        }
      }
      castFilterValue(type, cond, key, model);
      out[key] = cond;
    }
    return out;
  };
  return walk(filter);
}

// Mongoose save() also wrote the schema defaults a legacy document lacked; returns those as a patch.
export function defaultsToPersist(lean, hydrated, nested = []) {
  const out = {};
  for (const [k, v] of Object.entries(hydrated)) {
    if (k === "_id" || v === null || v === undefined) continue;
    if (nested.includes(k) && v && typeof v === "object") {
      const missing = Object.fromEntries(Object.entries(v).filter(([nk]) => lean?.[k]?.[nk] === undefined));
      if (Object.keys(missing).length) out[k] = missing;
    } else if (lean?.[k] === undefined) out[k] = v;
  }
  return out;
}
