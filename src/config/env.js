import dotenv from "dotenv";

dotenv.config(process.env.ENV_FILE ? { path: process.env.ENV_FILE } : undefined);
