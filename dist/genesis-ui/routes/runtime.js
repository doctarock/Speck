// Runtime status and options as the Genesis interface expects them.
import { runtimeOptions, toGenesisBrain } from "../presentation.js";
import { queuedWorkers, inProgressWorkers } from "../tasks.js";
export function registerRuntimeRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/runtime/status", async (_req, res) => {
        const models = runtime.modelRegistry.list();
        const brains = models.map(toGenesisBrain);
        const roleBrain = (role) => brains.find((brain) => brain.id === (role === "writer" ? runtime.config.modelRuntime.roles.writer || runtime.config.modelRuntime.roles.worker : runtime.config.modelRuntime.roles[role]));
        res.json({
            ok: true,
            implementation: "speck",
            coreVersion: "0.13.0",
            nodeVersion: process.version,
            uptimeMs: Date.now() - options.startedAt,
            gateway: { name: "speck", exists: true, running: true, status: "running" },
            intake: roleBrain("intake") ?? { label: "Speck Intake", model: "", running: true },
            planner: roleBrain("planner") ?? { label: "Speck Planner", model: "", running: models.length > 0 },
            worker: roleBrain("worker") ?? { label: "Speck Worker", model: "", running: models.length > 0 },
            writer: roleBrain("writer") ?? { label: "Speck Writer", model: "", running: models.length > 0 },
            toolCaller: roleBrain("toolCaller") ?? { label: "Speck Tool Caller", model: "", running: models.length > 0 },
            ollama: { exists: models.some((model) => model.provider === "ollama"), running: models.some((model) => model.provider === "ollama"), status: models.some((model) => model.provider === "ollama") ? "configured" : "not-configured" },
            qdrant: { enabled: false, running: false, status: "not-configured" },
            ollamaEndpoints: [],
            brains,
            brainActivity: models.map((model) => ({
                ...toGenesisBrain(model), active: false, endpointHealthy: model.available,
                queuedCount: queuedWorkers(runtime, archived).length, waitingCount: runtime.listWorkers("waiting").length,
                inProgressCount: inProgressWorkers(runtime, archived).length, failedCount: runtime.listWorkers("failed").length,
                idleForMs: 0, avgRequestMs: 0, avgRequestSampleCount: model.calls
            })),
            gpu: { available: false },
            profile: { id: options.profile.id, name: options.profile.name },
            pluginLoadErrors: [],
            checkedAt: Date.now()
        });
    });
    app.get("/api/runtime/options", (_req, res) => res.json(runtimeOptions(runtime, options.profile, state)));
}
//# sourceMappingURL=runtime.js.map