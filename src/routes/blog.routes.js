const express = require("express");
const { blogController } = require("../controllers/blog.controller");
const { authMiddleware, adminMiddleware } = require("../middlewares/auth.middleware");
const { blogValidationRules } = require("../validators/blog.validator");
const { validationResult } = require("express-validator");
const upload = require("../utils/multer");

const blogRouter = express.Router();

// PUBLIC
blogRouter.get("/", blogController.list);
blogRouter.get("/:idOrSlug", blogController.get);
blogRouter.get("/:id/related", blogController.related);

// ADMIN: inline image upload for CKEditor — must come BEFORE :idOrSlug shadows
blogRouter.post(
  "/upload-inline",
  authMiddleware,
  adminMiddleware,
  upload.single("upload"), // CKEditor SimpleUploadAdapter sends file under "upload"
  blogController.uploadInline
);

// ADMIN: create
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

// ADMIN: update
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

// ADMIN: delete
blogRouter.delete("/:id", authMiddleware, adminMiddleware, blogController.delete);

module.exports = { blogRouter };
