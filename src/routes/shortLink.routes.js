const express = require("express");
const { shortLinkController: c } = require("../controllers/shortLink.controller");
const { authMiddleware, donationsAdminMiddleware } = require("../middlewares/auth.middleware");

const shortLinkRouter = express.Router();

// PUBLIC — used by the website's /go/<code> redirect page
shortLinkRouter.get("/resolve/:code", c.resolve);

// ADMIN — managed from the UTM Builder (full admins and the donations admin role)
shortLinkRouter.get("/", authMiddleware, donationsAdminMiddleware, c.list);
shortLinkRouter.post("/", authMiddleware, donationsAdminMiddleware, c.create);
shortLinkRouter.delete("/:id", authMiddleware, donationsAdminMiddleware, c.remove);

module.exports = { shortLinkRouter };
