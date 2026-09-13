
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../utils/utils");

const authMiddleware = (req, res, next) => {
	let token;
	const authHeader = req.headers.authorization;
	if (authHeader && authHeader.startsWith("Bearer ")) {
		token = authHeader.split(" ")[1];
	} else if (req.cookies && req.cookies.token) {
		token = req.cookies.token;
	}

	if (process.env.DEBUG_AUTH === 'true') {
		console.log('[DEBUG_AUTH] authHeader present:', !!authHeader, 'cookieToken present:', !!(req.cookies && req.cookies.token));
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

// Scoped access for /donations/admin only — a donations_admin account can
// manage that page's content/transactions/UTM stats but must NOT be able
// to reach the rest of the site's admin (banners, blogs, campaigners,
// staff management, etc.). Full admins can still do everything.
const donationsAdminMiddleware = (req, res, next) => {
	if (req.user.role !== "admin" && req.user.role !== "donations_admin") {
		return res.status(403).json({ message: "Admin access required" });
	}
	next();
};

// Scoped access for blog create/update/upload only — a blogs_admin account
// can write and edit posts but cannot delete them outright (see blog
// controller: a blogs_admin's delete call creates a pending deletion
// request instead of deleting) and cannot reach any other admin area.
const blogsAdminMiddleware = (req, res, next) => {
	if (req.user.role !== "admin" && req.user.role !== "blogs_admin") {
		return res.status(403).json({ message: "Admin access required" });
	}
	next();
};

// Scoped access for the preacher dashboard, per-module. Unlike the other
// scoped middlewares above (which only check req.user.role from the JWT),
// this does a fresh DB lookup — a preacher's allowedModules can change at
// any time (admin revokes a module), and that should take effect
// immediately, not just the next time they log in and get a new token.
// Full admins always pass, regardless of module.
const preacherModuleMiddleware = (moduleName) => async (req, res, next) => {
	if (req.user.role === "admin") return next();
	if (req.user.role !== "preacher") {
		return res.status(403).json({ message: "Preacher access required" });
	}
	try {
		const { userModel } = require("../models/user.model");
		const user = await userModel.findById(req.user.userId).select("status allowedModules role");
		if (!user || user.role !== "preacher" || user.status !== "active") {
			return res.status(403).json({ message: "Preacher account not active" });
		}
		if (!user.allowedModules || !user.allowedModules.includes(moduleName)) {
			return res.status(403).json({ message: `You don't have access to this module (${moduleName}). Ask an admin to grant it.` });
		}
		next();
	} catch (err) {
		res.status(500).json({ message: "Server error checking preacher access" });
	}
};

module.exports = { authMiddleware, adminMiddleware, donationsAdminMiddleware, blogsAdminMiddleware, preacherModuleMiddleware };