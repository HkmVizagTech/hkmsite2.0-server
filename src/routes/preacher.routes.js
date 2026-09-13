const express = require("express");
const { preacherController } = require("../controllers/preacher.controller");
const { authMiddleware, preacherModuleMiddleware } = require("../middlewares/auth.middleware");

const preacherRouter = express.Router();

// Every route here requires authentication plus the specific module
// grant — a preacher only reaches what an admin has explicitly given
// them access to. Full admins can always reach everything too (enforced
// inside preacherModuleMiddleware itself).
preacherRouter.get("/my-donors", authMiddleware, preacherModuleMiddleware("my-donors"), preacherController.myDonors);
preacherRouter.get("/my-donors/:donorRecordId/donations", authMiddleware, preacherModuleMiddleware("my-donors"), preacherController.donorDonations);
preacherRouter.get("/my-reports", authMiddleware, preacherModuleMiddleware("my-reports"), preacherController.myReports);
preacherRouter.post("/donations/:id/resend-whatsapp", authMiddleware, preacherModuleMiddleware("resend"), preacherController.resendWhatsApp);

module.exports = { preacherRouter };
