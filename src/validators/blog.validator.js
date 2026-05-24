const { body } = require("express-validator");

const blogValidationRules = [
  body("title")
    .trim()
    .notEmpty().withMessage("Title is required")
    .isLength({ max: 200 }).withMessage("Title too long"),
  body("content")
    .notEmpty().withMessage("Content is required")
    .isLength({ min: 30 }).withMessage("Content too short"),
  body("excerpt").optional().isLength({ max: 500 }).withMessage("Excerpt too long"),
  body("category").optional().isIn([
    "Spirituality", "Festivals", "Vizag Guide", "Recipes", "Philosophy", "General",
  ]).withMessage("Invalid category"),
  body("status").optional().isIn(["draft", "published"]).withMessage("Invalid status"),
  body("tags").optional(), // accepted either as JSON string or array (multipart-friendly)
];

module.exports = { blogValidationRules };
