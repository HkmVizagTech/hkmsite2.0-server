import express from "express";
import { darshanController } from "../controllers/darshan.controller.js";

const darshanRouter = express.Router();

// Public — read-only, used by the homepage's Today's Darshan section.
darshanRouter.get("/", darshanController.list);

darshanRouter.post("/sync", express.json({ limit: "1mb" }), darshanController.sync);

export { darshanRouter };
