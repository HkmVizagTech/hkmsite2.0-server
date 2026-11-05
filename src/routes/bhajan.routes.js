const express = require("express");
const { bhajanController } = require("../controllers/bhajan.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");
const upload = require("../utils/multer");
const uploadAudio = require("../utils/multerAudio");

const bhajanRouter = express.Router();
const admin = [authMiddleware, adminMiddleware];

// Turn multer errors into clear JSON 400s (the global handler's size message
// talks about images).
const single = (mw, tooLargeMsg) => (req, res, next) =>
  mw.single("file")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE" ? tooLargeMsg : err.message || "Upload error";
    res.status(400).json({ message });
  });

// Order matters: fixed paths before /:slug.
bhajanRouter.get("/", bhajanController.list);
bhajanRouter.get("/meta", bhajanController.meta);
bhajanRouter.get("/taxonomy/:type", bhajanController.taxonomyList);
bhajanRouter.get("/taxonomy/:type/:slug", bhajanController.taxonomyGet);
bhajanRouter.get("/admin/taxonomy/:type", ...admin, bhajanController.adminTaxonomyList);
bhajanRouter.put("/admin/taxonomy/:type/:slug", ...admin, bhajanController.adminTaxonomyUpsert);
bhajanRouter.post("/upload/taxonomy-image", ...admin, single(upload, "Image is too large (max 10MB)."), bhajanController.uploadTaxonomyImage);
bhajanRouter.get("/admin/list", ...admin, bhajanController.adminList);
bhajanRouter.put("/admin/:id/tracks/:trackId/verse-times", ...admin, bhajanController.updateVerseTimes);
bhajanRouter.get("/admin/:id", ...admin, bhajanController.adminGet);
bhajanRouter.post("/upload/cover", ...admin, single(upload, "Image is too large (max 10MB)."), bhajanController.uploadCover);
bhajanRouter.post("/upload/audio", ...admin, single(uploadAudio, "Audio is too large (max 60MB)."), bhajanController.uploadAudio);
bhajanRouter.post("/", ...admin, bhajanController.create);
bhajanRouter.get("/:slug", bhajanController.getBySlug);
bhajanRouter.post("/:slug/play", bhajanController.play);
bhajanRouter.put("/:id", ...admin, bhajanController.update);
bhajanRouter.delete("/:id", ...admin, bhajanController.delete);

module.exports = { bhajanRouter };
