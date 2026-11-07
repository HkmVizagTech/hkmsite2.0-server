const express = require("express");
const { gitaCourseController } = require("../controllers/gitaCourse.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const gitaCourseRouter = express.Router();

// PUBLIC - register for the free Understand Gita course
gitaCourseRouter.post("/register", gitaCourseController.register);

// ADMIN - view and manage registrations
gitaCourseRouter.get("/registrations", authMiddleware, adminMiddleware, gitaCourseController.list);
gitaCourseRouter.put("/registrations/:id/status", authMiddleware, adminMiddleware, gitaCourseController.updateStatus);

module.exports = { gitaCourseRouter };
