import express from "express";
import { preacherController } from "../controllers/preacher.controller.js";
import { authMiddleware, preacherModuleMiddleware } from "../middlewares/auth.middleware.js";

const preacherRouter = express.Router();

preacherRouter.get(
  "/search-donor",
  authMiddleware,
  preacherModuleMiddleware("raise-receipt"),
  preacherController.searchDonor
);
preacherRouter.get("/my-donors", authMiddleware, preacherModuleMiddleware("my-donors"), preacherController.myDonors);
preacherRouter.get(
  "/my-donors/:donorRecordId/donations",
  authMiddleware,
  preacherModuleMiddleware("my-donors"),
  preacherController.donorDonations
);
preacherRouter.get("/my-reports", authMiddleware, preacherModuleMiddleware("my-reports"), preacherController.myReports);
preacherRouter.post(
  "/donations/:id/resend-whatsapp",
  authMiddleware,
  preacherModuleMiddleware("resend"),
  preacherController.resendWhatsApp
);

export { preacherRouter };
