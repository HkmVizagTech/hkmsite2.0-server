import jwt from "jsonwebtoken";
import { getJwtSecret } from "../utils/utils.js";
import { users } from "../db/tables.js";
import { castQueryId } from "../domain/store.js";

const authMiddleware = (req, res, next) => {
  let token;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (process.env.DEBUG_AUTH === "true") {
    console.log(
      "[DEBUG_AUTH] authHeader present:",
      !!authHeader,
      "cookieToken present:",
      !!(req.cookies && req.cookies.token)
    );
  }
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

const donationsAdminMiddleware = (req, res, next) => {
  if (req.user.role !== "admin" && req.user.role !== "donations_admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

const blogsAdminMiddleware = (req, res, next) => {
  if (req.user.role !== "admin" && req.user.role !== "blogs_admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

const shopAdminMiddleware = (req, res, next) => {
  if (req.user.role !== "admin" && req.user.role !== "shop_admin") {
    return res.status(403).json({ message: "Shop admin access required" });
  }
  next();
};

const preacherModuleMiddleware = (moduleName) => async (req, res, next) => {
  if (req.user.role === "admin") return next();
  if (req.user.role !== "preacher") {
    return res.status(403).json({ message: "Preacher access required" });
  }
  try {
    const user = await users.findById(castQueryId(req.user.userId, "user"), {
      fields: ["status", "allowedModules", "role"],
    });
    if (!user || user.role !== "preacher" || user.status !== "active") {
      return res.status(403).json({ message: "Preacher account not active" });
    }
    if (!user.allowedModules || !user.allowedModules.includes(moduleName)) {
      return res
        .status(403)
        .json({ message: `You don't have access to this module (${moduleName}). Ask an admin to grant it.` });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: "Server error checking preacher access" });
  }
};

const donorAuthMiddleware = (req, res, next) => {
  let token;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.cookies && req.cookies.donorToken) {
    token = req.cookies.donorToken;
  }
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.type !== "donor") {
      return res.status(401).json({ message: "Invalid session" });
    }
    req.donor = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired session" });
  }
};

export {
  authMiddleware,
  adminMiddleware,
  donationsAdminMiddleware,
  blogsAdminMiddleware,
  shopAdminMiddleware,
  preacherModuleMiddleware,
  donorAuthMiddleware,
};
