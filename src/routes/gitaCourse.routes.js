const express = require("express");
const { gitaCourseController: c } = require("../controllers/gitaCourse.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const gitaCourseRouter = express.Router();
const admin = [authMiddleware, adminMiddleware];

// PUBLIC - register for the free Understand Gita course
gitaCourseRouter.post("/register", c.register);

// ADMIN - batches
gitaCourseRouter.get("/batches", ...admin, c.listBatches);
gitaCourseRouter.post("/batches", ...admin, c.createBatch);
gitaCourseRouter.put("/batches/:id", ...admin, c.updateBatch);
gitaCourseRouter.delete("/batches/:id", ...admin, c.deleteBatch);

// ADMIN - registrations
gitaCourseRouter.get("/registrations", ...admin, c.list);
gitaCourseRouter.get("/registrations/export", ...admin, c.exportCsv);
gitaCourseRouter.put("/registrations/bulk", ...admin, c.bulkUpdate);
gitaCourseRouter.put("/registrations/:id", ...admin, c.updateRegistration);
gitaCourseRouter.put("/registrations/:id/status", ...admin, c.updateStatus);

module.exports = { gitaCourseRouter };
