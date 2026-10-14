import express from "express";
import { preacherController } from "../controllers/preacher.controller.js";
import { authMiddleware, preacherModuleMiddleware } from "../middlewares/auth.middleware.js";

const preacherRouter = express.Router();

// Every route here requires authentication plus the specific module
// grant — a preacher only reaches what an admin has explicitly given
// them access to. Full admins can always reach everything too (enforced
// inside preacherModuleMiddleware itself).
preacherRouter.get("/search-donor", authMiddleware, preacherModuleMiddleware("raise-receipt"), preacherController.searchDonor);
preacherRouter.get("/my-donors", authMiddleware, preacherModuleMiddleware("my-donors"), preacherController.myDonors);
preacherRouter.get("/my-donors/:donorRecordId/donations", authMiddleware, preacherModuleMiddleware("my-donors"), preacherController.donorDonations);
preacherRouter.get("/my-reports", authMiddleware, preacherModuleMiddleware("my-reports"), preacherController.myReports);
preacherRouter.post("/donations/:id/resend-whatsapp", authMiddleware, preacherModuleMiddleware("resend"), preacherController.resendWhatsApp);

export { preacherRouter };