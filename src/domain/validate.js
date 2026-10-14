export const pick = (obj, keys) => {
  const out = {};
  for (const k of keys)
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

export const publicUser = (u) => {
  if (!u) return u;
  const { password, ...rest } = u;
  return rest;
};
