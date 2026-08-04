const express = require("express");
const { volunteerController } = require("../controllers/volunteer.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const volunteerRouter = express.Router();

volunteerRouter.get("/admin/all", authMiddleware, adminMiddleware, volunteerController.listAll);
volunteerRouter.post("/admin", authMiddleware, adminMiddleware, volunteerController.create);
volunteerRouter.put("/admin/registrations/:id", authMiddleware, adminMiddleware, volunteerController.updateRegistration);
volunteerRouter.delete("/admin/registrations/:id", authMiddleware, adminMiddleware, volunteerController.deleteRegistration);
volunteerRouter.get("/admin/:id/registrations", authMiddleware, adminMiddleware, volunteerController.listRegistrations);
volunteerRouter.put("/admin/:id", authMiddleware, adminMiddleware, volunteerController.update);
volunteerRouter.delete("/admin/:id", authMiddleware, adminMiddleware, volunteerController.delete);

volunteerRouter.get("/", volunteerController.listActive);
volunteerRouter.get("/:id", volunteerController.get);
volunteerRouter.post("/:id/register", volunteerController.register);

module.exports = { volunteerRouter };
