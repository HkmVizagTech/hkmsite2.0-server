const express = require("express");
const { blogController } = require("../controllers/blog.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");
const { blogValidationRules } = require("../validators/blog.validator");
const { validationResult } = require("express-validator");
const upload = require("../utils/multer");

const blogRouter = express.Router();

// PUBLIC - landing data (multi-section /blogs page)
// Returns recents, devotional, categories, byCategory, popular, recent in one call
blogRouter.get("/landing", blogController.landing);

// PUBLIC - categories with counts (for nav/filter)
blogRouter.get("/categories", blogController.categories);

// PUBLIC - paginated/filterable list
blogRouter.get("/", blogController.list);

// ADMIN - inline image upload for CKEditor (must come before :idOrSlug)
blogRouter.post(
  "/upload-inline",
  authMiddleware,
  adminMiddleware,
  upload.single("upload"),
  blogController.uploadInline
);

// ADMIN - create
blogRouter.post(
  "/",
  authMiddleware,
  adminMiddleware,
  upload.any(),
  blogValidationRules,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
  blogController.create
);

// PUBLIC - get one by slug or id (must come after the static routes above)
blogRouter.get("/:idOrSlug", blogController.get);

// PUBLIC - related
blogRouter.get("/:id/related", blogController.related);

// ADMIN - update
blogRouter.put(
  "/:id",
  authMiddleware,
  adminMiddleware,
  upload.any(),
  blogValidationRules,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
  blogController.update
);

// ADMIN - delete
blogRouter.delete("/:id", authMiddleware, adminMiddleware, blogController.delete);

module.exports = { blogRouter };
