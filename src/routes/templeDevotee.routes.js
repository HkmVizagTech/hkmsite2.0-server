const express = require("express");
const { templeDevoteeController } = require("../controllers/templeDevotee.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");

const templeDevoteeRouter = express.Router();

templeDevoteeRouter.get("/", templeDevoteeController.publicList); // public — dropdown for campaigner registration
// public — does this seva-link code credit a preacher (DCC id other than 36)? Answers yes/no only; the seva forms use
// it to hide the Maha Prasadam option for preacher-credited donations.
templeDevoteeRouter.get("/ref-check/:ref", async (req, res) => {
  try {
    const d = await require("../utils/preacherRef").resolvePreacherRef(req.params.ref);
    res.status(200).json({ success: true, credited: !!d && Number(d.dccEnrolledById) !== 36 });
  } catch {
    res.status(200).json({ success: true, credited: false });
  }
});
templeDevoteeRouter.get("/admin/list", authMiddleware, adminMiddleware, templeDevoteeController.adminList);
templeDevoteeRouter.get("/admin/analytics", authMiddleware, adminMiddleware, templeDevoteeController.analytics);
templeDevoteeRouter.post("/admin", authMiddleware, adminMiddleware, templeDevoteeController.create);
templeDevoteeRouter.put("/admin/:id", authMiddleware, adminMiddleware, templeDevoteeController.update);

module.exports = { templeDevoteeRouter };
