// Mirrors the message format of the old Mongoose validation errors.
const label = (v) => (typeof v === "string" ? v : JSON.stringify(v));

export function validateDoc(modelName, doc, { required = [], enums = {} } = {}) {
  const errors = [];
  for (const f of required) {
    const v = doc[f];
    if (v === undefined || v === null || v === "") errors.push(`${f}: Path \`${f}\` is required.`);
  }
  for (const [f, allowed] of Object.entries(enums)) {
    const v = doc[f];
    if (v !== undefined && v !== null && !allowed.includes(v)) {
      errors.push(`${f}: \`${label(v)}\` is not a valid enum value for path \`${f}\`.`);
    }
  }
  if (errors.length) {
    const err = new Error(`${modelName} validation failed: ${errors.join(", ")}`);
    err.name = "ValidationError";
    throw err;
  }
}

export const pick = (obj, keys) => {
  const out = {};
  for (const k of keys)
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

export const toStringArray = (v) => {
  if (v === undefined || v === null) return undefined;
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
};

// Date-only strings are UTC midnight (what Mongoose did), not the Postgres session zone.
export const toDate = (v, path = "date") => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);
  if (Number.isNaN(d.getTime())) throw new Error(`Cast to date failed for value "${v}" at path "${path}"`);
  return d;
};

export const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";

export const publicUser = (u) => {
  if (!u) return u;
  const { password, ...rest } = u;
  return rest;
};

// Splits `u_id/u_name/u_email` join columns off a row; returns [rowWithoutThem, populatedUser|null].
export const splitUser = (row, prefix = "u_") => {
  const rest = {};
  const user = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith(prefix)) user[k.slice(prefix.length)] = v;
    else rest[k] = v;
  }
  return [rest, user.id ? { _id: user.id, name: user.name, email: user.email } : null];
};
