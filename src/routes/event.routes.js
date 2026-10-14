import express from "express";
import { eventController } from "../controllers/event.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";
import { eventValidationRules } from "../validators/event.validator.js";
import { validationResult } from "express-validator";
import upload from "../utils/multer.js";

const eventRouter = express.Router();

import { register, listRegistrations, markAttendance, publicCheckin } from "../controllers/registration.controller.js";

eventRouter.get("/", eventController.list);
eventRouter.get("/:id", eventController.get);

eventRouter.post("/:id/register", upload.any(), register);

eventRouter.post(
  "/",
  authMiddleware,
  adminMiddleware,
  upload.array("images", 5),
  eventValidationRules,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  eventController.create
);
// Update event (allow multipart/form-data and images)
eventRouter.put(
  "/:id",
  authMiddleware,
  adminMiddleware,
  upload.array("images", 5),
  eventValidationRules,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  eventController.update
);
eventRouter.delete("/:id", authMiddleware, adminMiddleware, eventController.delete);

eventRouter.get("/:id/registrations", authMiddleware, adminMiddleware, listRegistrations);

eventRouter.post("/:id/registrations/:token/attendance", authMiddleware, adminMiddleware, markAttendance);

eventRouter.post("/:id/checkin/:token", publicCheckin);

export { eventRouter };
