const express = require("express");
const { darshanController } = require("../controllers/darshan.controller");

const darshanRouter = express.Router();

// Public — read-only, used by the homepage's Today's Darshan section.
darshanRouter.get("/", darshanController.list);

// Internal — hit by the Vaikuntham admin panel on every darshan add/edit/
// block/delete. Shared-secret auth (x-darshan-sync-secret), not a user
// JWT/adminMiddleware, since the caller is another server, not a logged-in
// admin browser session.
darshanRouter.post("/sync", express.json({ limit: "1mb" }), darshanController.sync);

module.exports = { darshanRouter };
