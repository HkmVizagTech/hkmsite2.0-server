const express = require("express");
const { programController: c } = require("../controllers/program.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const programRouter = express.Router();
const admin = [authMiddleware, adminMiddleware];

// PUBLIC — the program's own page on the website
programRouter.get("/public/:slug", c.getPublic);
programRouter.post("/public/:slug/register", c.register);
programRouter.post("/public/registrations/:id/verify", c.verify);

// ADMIN — programs
programRouter.get("/", ...admin, c.listPrograms);
programRouter.post("/", ...admin, c.createProgram);
programRouter.put("/:id", ...admin, c.updateProgram);
programRouter.delete("/:id", ...admin, c.deleteProgram);

// ADMIN — dashboard + registrations
programRouter.get("/stats", ...admin, c.stats);
programRouter.get("/registrations", ...admin, c.listRegistrations);
programRouter.get("/registrations/export", ...admin, c.exportCsv);
programRouter.post("/registrations/:id/mark-paid", ...admin, c.markPaid);
programRouter.post("/registrations/:id/check-payment", ...admin, c.checkPayment);
programRouter.post("/registrations/:id/whatsapp", ...admin, c.resendWhatsapp);

module.exports = { programRouter };
