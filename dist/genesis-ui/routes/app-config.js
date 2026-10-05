// Interface settings.
import { appConfig } from "../presentation.js";
export function registerAppConfigRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/app/config", (_req, res) => res.json({ ok: true, app: appConfig(state) }));
    app.post("/api/app/config", async (req, res) => {
        state.app = req.body?.app && typeof req.body.app === "object" ? structuredClone(req.body.app) : state.app;
        await saveState();
        res.json({ ok: true, app: appConfig(state), message: "Speck interface settings saved." });
    });
}
//# sourceMappingURL=app-config.js.map