const express = require("express");
const { volunteerController } = require("../controllers/volunteer.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const volunteerRouter = express.Router();

volunteerRouter.get("/admin/signups", authMiddleware, adminMiddleware, volunteerController.listSignups);
volunteerRouter.put("/admin/signups/:id", authMiddleware, adminMiddleware, volunteerController.updateSignup);
volunteerRouter.delete("/admin/signups/:id", authMiddleware, adminMiddleware, volunteerController.deleteSignup);
volunteerRouter.get("/admin/all", authMiddleware, adminMiddleware, volunteerController.listAll);
volunteerRouter.post("/admin", authMiddleware, adminMiddleware, volunteerController.create);
volunteerRouter.put("/admin/registrations/:id", authMiddleware, adminMiddleware, volunteerController.updateRegistration);
volunteerRouter.delete("/admin/registrations/:id", authMiddleware, adminMiddleware, volunteerController.deleteRegistration);
volunteerRouter.get("/admin/:id/registrations", authMiddleware, adminMiddleware, volunteerController.listRegistrations);
volunteerRouter.put("/admin/:id", authMiddleware, adminMiddleware, volunteerController.update);
volunteerRouter.delete("/admin/:id", authMiddleware, adminMiddleware, volunteerController.delete);

volunteerRouter.post("/signup", volunteerController.signup);
volunteerRouter.get("/", volunteerController.listActive);
volunteerRouter.get("/:id", volunteerController.get);
volunteerRouter.post("/:id/register", volunteerController.register);

module.exports = { volunteerRouter };
