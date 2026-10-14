import express from "express";
import { productController } from "../controllers/product.controller.js";
import { shopOrderController } from "../controllers/shopOrder.controller.js";
import { authMiddleware, shopAdminMiddleware } from "../middlewares/auth.middleware.js";
import upload from "../utils/multer.js";

const shopAdminRouter = express.Router();

shopAdminRouter.use(authMiddleware, shopAdminMiddleware);

// ---- Products ----
shopAdminRouter.get("/products", productController.adminListProducts);
shopAdminRouter.post("/products", productController.createProduct);
shopAdminRouter.patch("/products/:id", productController.updateProduct);
shopAdminRouter.patch("/products/:id/stock", productController.adjustStock);
shopAdminRouter.delete("/products/:id", productController.deleteProduct);

// Multer handles this one's body, so it must not also be parsed as JSON.
shopAdminRouter.post("/upload-image", upload.single("file"), productController.uploadImage);

// ---- Categories ----
shopAdminRouter.get("/categories", productController.adminListCategories);
shopAdminRouter.post("/categories", productController.createCategory);
shopAdminRouter.patch("/categories/:id", productController.updateCategory);
shopAdminRouter.delete("/categories/:id", productController.deleteCategory);

// ---- Orders ----
shopAdminRouter.get("/orders", shopOrderController.adminListOrders);
shopAdminRouter.patch("/orders/:id", shopOrderController.adminUpdateOrder);

// ---- Settings ----
shopAdminRouter.get("/settings", productController.getAdminSettings);
shopAdminRouter.patch("/settings", productController.updateSettings);

export { shopAdminRouter };
