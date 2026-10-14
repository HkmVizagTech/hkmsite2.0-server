import express from "express";
import { register, listRegistrations, markAttendance } from "../controllers/registration.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";
import upload from "../utils/multer.js";

const registrationRouter = express.Router();

registrationRouter.post("/:eventId/register", upload.any(), register);

registrationRouter.get("/:eventId", authMiddleware, adminMiddleware, listRegistrations);

registrationRouter.post("/:eventId/:token/attendance", authMiddleware, adminMiddleware, markAttendance);

export { registrationRouter };