import { timingSafeEqual } from "node:crypto";

export const secretMatches = (supplied, expected) => {
  if (!expected || typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const internalAuth = (req, res, next) => {
  if (!secretMatches(req.headers["x-internal-secret"], process.env.INTERNAL_SECRET)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};
