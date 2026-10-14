import express from "express";
import { importantDateController } from "../controllers/importantDate.controller.js";
import { authMiddleware, adminMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/", importantDateController.list);
router.get("/:id", importantDateController.get);

router.post("/", authMiddleware, adminMiddleware, importantDateController.create);
router.put("/:id", authMiddleware, adminMiddleware, importantDateController.update);
router.delete("/:id", authMiddleware, adminMiddleware, importantDateController.delete);

export { router as importantDateRouter };
