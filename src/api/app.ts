import express, { type Express } from "express";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import { registerSpeckRoutes, speckErrorHandler } from "./routes.js";

export function createSpeckApp(runtime: SpeckRuntime): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  registerSpeckRoutes(app, runtime);
  app.use(speckErrorHandler);
  return app;
}
