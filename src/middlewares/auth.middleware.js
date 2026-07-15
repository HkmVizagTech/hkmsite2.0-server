
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

module.exports = { authMiddleware, adminMiddleware, donationsAdminMiddleware };