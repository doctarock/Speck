import express from "express";
import { registerSpeckRoutes, speckErrorHandler } from "./routes.js";
export function createSpeckApp(runtime) {
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "1mb" }));
    registerSpeckRoutes(app, runtime);
    app.use(speckErrorHandler);
    return app;
}
//# sourceMappingURL=app.js.map