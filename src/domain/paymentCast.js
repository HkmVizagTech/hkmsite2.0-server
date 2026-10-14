import assert from "node:assert";
import util from "node:util";

// Reproduces how the old Mongoose donation schema cast, defaulted and validated a document created from a request
// body (verified against the real model by scripts/parity/cast-donation.mjs).

const STRING = "string";
const NUMBER = "Number";
const BOOLEAN = "Boolean";
const OBJECT_ID = "ObjectId";
const NESTED = "nested";

// Schema order matters: Mongoose reports errors in this order.
const SCHEMA = [
  ["donorName", STRING, { required: true }],
  ["donorEmail", STRING],
  ["donorMobile", STRING],
  ["amount", NUMBER, { required: true }],
  ["type", STRING],
  ["status", STRING],
  ["message", STRING],
  ["sourcePage", STRING],
  ["sevaName", STRING],
  ["sevaSlug", STRING],
  ["bannerImage", STRING],
  ["legacySevaId", NUMBER],
  ["paymentAccount", STRING],
  ["transactionId", STRING],
  ["festivalId", OBJECT_ID],
  ["festivalSlug", STRING],
  ["campaignerSlug", STRING],
  ["dccEnrolledById", NUMBER],
  ["panNumber", STRING],
  ["certificate", BOOLEAN],
  ["sevakName", STRING],
  ["sevaDate", STRING],
  ["dob", STRING],
  ["wantPrasadam", BOOLEAN],
  ["prasadamAddress", NESTED],
  ["razorpayOrderId", STRING],
  ["razorpayPaymentId", STRING],
  ["subscriptionId", STRING],
  ["isRecurring", BOOLEAN],
  ["metaEventId", STRING],
  ["metaFbp", STRING],
  ["metaFbc", STRING],
  ["metaClientIp", STRING],
  ["metaUserAgent", STRING],
];
const DEFS = new Map(SCHEMA.map(([name, type, opts]) => [name, { type, ...opts }]));
const ADDRESS_KEYS = ["doorNo", "house", "street", "area", "country", "state", "city", "pincode"];
const PASSTHROUGH = ["utm", "createdAt", "date"];

const stringValue = (value) => {
  let s = util.inspect(value).replace(/^'|'$/g, '"');
  if (!s.startsWith('"')) s = `"${s}"`;
  return s;
};
const valueType = (value) => {
  if (value == null) return String(value);
  const t = typeof value;
  if (t !== "object") return t;
  return typeof value.constructor === "function" ? value.constructor.name : t;
};
const castMessage = (kind, value, path, reason) =>
  `Cast to ${kind} failed for value ${stringValue(value)} (type ${valueType(value)}) at path "${path}"${reason ? ` because of "${reason}"` : ""}`;

class CastFailure extends Error {}

const castString = (value, path) => {
  try {
    if (value == null) return value;
    if (value._id && typeof value._id === "string") return value._id;
    if (value.toString && value.toString !== Object.prototype.toString && !Array.isArray(value))
      return value.toString();
  } catch {}
  throw new CastFailure(castMessage("string", value, path));
};

const castNumber = (raw, path) => {
  const original = raw && typeof raw._id !== "undefined" ? raw._id : raw;
  try {
    let val = original;
    if (val == null) return val;
    if (val === "") return null;
    if (typeof val === "string" || typeof val === "boolean") val = Number(val);
    if (Number.isNaN(Number(val))) throw new assert.AssertionError({ message: "nan" });
    if (typeof val === "number") return val;
    if (!Array.isArray(val) && typeof val.valueOf === "function") return Number(val.valueOf());
    throw new assert.AssertionError({ message: "not a number" });
  } catch (err) {
    const name = err && err.constructor && err.constructor.name;
    throw new CastFailure(
      castMessage("Number", original, path, name === "AssertionError" || name === "Error" ? null : name)
    );
  }
};

const TRUE = new Set([true, "true", 1, "1", "yes"]);
const FALSE = new Set([false, "false", 0, "0", "no"]);
const castBoolean = (value, path) => {
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  if (value == null) return value;
  throw new CastFailure(castMessage("Boolean", value, path, "CastError"));
};

// Only 24-hex strings cast (Mongoose 8 / bson 6 reject 12-character strings).
const castObjectId = (value, path) => {
  if (value == null) return value;
  const src = value._id ? value._id : value;
  const str = typeof src === "string" ? src : src.toString instanceof Function ? src.toString() : src;
  if (typeof str === "string" && /^[0-9a-fA-F]{24}$/.test(str)) return str.toLowerCase();
  throw new CastFailure(castMessage("ObjectId", value, path, "BSONError"));
};

const CASTERS = { [STRING]: castString, [NUMBER]: castNumber, [BOOLEAN]: castBoolean, [OBJECT_ID]: castObjectId };

/**
 * Casts `input` like `donationModel.create(input)` did.
 * Throws the same ValidationError message Mongoose produced; otherwise returns the document to insert.
 */
function castPaymentDonation(input) {
  const out = {};
  const errors = new Map();
  const present = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  const castAddress = (raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { country: null }; // stored as nothing
    const addr = {};
    for (const key of ADDRESS_KEYS) {
      if (raw[key] === undefined) continue;
      const path = `prasadamAddress.${key}`;
      try {
        addr[key] = castString(raw[key], path);
      } catch (err) {
        if (!(err instanceof CastFailure)) throw err;
        errors.set(path, err.message);
      }
    }
    return addr;
  };

  for (const [name] of SCHEMA) {
    if (!present(name)) continue;
    const def = DEFS.get(name);
    if (def.type === NESTED) {
      out[name] = castAddress(input[name]);
      continue;
    }
    try {
      const v = CASTERS[def.type](input[name], name);
      if (v !== undefined) out[name] = v;
    } catch (err) {
      if (!(err instanceof CastFailure)) throw err;
      errors.set(name, err.message);
    }
  }

  for (const key of PASSTHROUGH) if (present(key)) out[key] = input[key];

  for (const [name, def] of DEFS) {
    if (!def.required || errors.has(name)) continue;
    const v = out[name];
    if (v === undefined || v === null || (def.type === STRING && v === ""))
      errors.set(name, `Path \`${name}\` is required.`);
  }

  if (errors.size) {
    const err = new Error(`donation validation failed: ${[...errors].map(([p, m]) => `${p}: ${m}`).join(", ")}`);
    err.name = "ValidationError";
    throw err;
  }
  return out;
}

// What findById / filters on _id threw for a malformed id.
function castPaymentDonationId(value, path = "_id") {
  if (value === undefined || value === null || (typeof value === "string" && /^[0-9a-f]{24}$/i.test(value)))
    return value;
  const err = new Error(`${castMessage("ObjectId", value, path)} for model "donation"`);
  err.name = "CastError";
  throw err;
}

export { castPaymentDonation, castPaymentDonationId };
