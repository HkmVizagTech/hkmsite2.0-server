import express from "express";
import { blogController } from "../controllers/blog.controller.js";
import { authMiddleware, adminMiddleware, blogsAdminMiddleware } from "../middlewares/auth.middleware.js";
import { blogValidationRules } from "../validators/blog.validator.js";
import { validationResult } from "express-validator";
import upload from "../utils/multer.js";

const blogRouter = express.Router();

// PUBLIC - landing data (multi-section /blogs page)
// Returns recents, devotional, categories, byCategory, popular, recent in one call
blogRouter.get("/landing", blogController.landing);

// PUBLIC - categories with counts (for nav/filter)
blogRouter.get("/categories", blogController.categories);

// PUBLIC - paginated/filterable list
blogRouter.get("/", blogController.list);

// ADMIN (full admin or blogs_admin) - inline image upload for CKEditor
// (must come before :idOrSlug)
blogRouter.post(
  "/upload-inline",
  authMiddleware,
  blogsAdminMiddleware,
  upload.single("upload"),
  blogController.uploadInline
);

// ADMIN ONLY - list posts with a pending deletion request (must come before
// :idOrSlug so "deletion-requests" isn't parsed as a post id/slug)
blogRouter.get("/deletion-requests", authMiddleware, adminMiddleware, blogController.deletionRequests);

// ADMIN (full admin or blogs_admin) - create
blogRouter.post(
  "/",
  authMiddleware,
  blogsAdminMiddleware,
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

// ADMIN (full admin or blogs_admin) - update
blogRouter.put(
  "/:id",
  authMiddleware,
  blogsAdminMiddleware,
  upload.any(),
  blogValidationRules,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
  blogController.update
);

// ADMIN (full admin deletes immediately; blogs_admin files a request instead
// - see blogController.delete)
blogRouter.delete("/:id", authMiddleware, blogsAdminMiddleware, blogController.delete);

// ADMIN ONLY - approve/reject a pending deletion request
blogRouter.post("/:id/approve-deletion", authMiddleware, adminMiddleware, blogController.approveDeletion);
blogRouter.post("/:id/reject-deletion", authMiddleware, adminMiddleware, blogController.rejectDeletion);

export { blogRouter };
