// Configuration: model processors and roles, embeddings, tools, the browser, secrets and memory admission.
import fs from "node:fs/promises";
import path from "node:path";
import { browserRuntimeConfigPath, modelProcessorConfigPath, validateBrowserRuntime, validateEmbeddingRuntime, validateModelProcessors, validateModelRoles } from "../../config.js";
import { createConfiguredProcessor } from "../../models/providers.js";
import { normalizeMemoryAdmissionPolicy } from "../../memory/admission.js";
import { playwrightHealth } from "../../tools/playwright.js";
import { brainConfig, toolConfig, errorMessage } from "../presentation.js";
export function registerConfigRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/brains/config", (_req, res) => res.json(brainConfig(runtime)));
    app.post("/api/brains/config", async (req, res) => {
        try {
            const processors = validateModelProcessors(req.body?.processors);
            const roles = validateModelRoles(req.body?.roles, processors);
            const priorIds = new Set(runtime.config.modelRuntime.processors.map((processor) => processor.id));
            for (const id of priorIds)
                runtime.modelRegistry.remove(id);
            for (const processor of processors)
                runtime.modelRegistry.upsert(processor, createConfiguredProcessor(processor));
            runtime.config.modelRuntime.processors = processors;
            runtime.config.modelRuntime.roles = roles;
            const target = modelProcessorConfigPath(config.genesisRuntimePath);
            const temporary = `${target}.tmp`;
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(temporary, `${JSON.stringify({ processors, roles, embedding: runtime.config.embeddingRuntime }, null, 2)}\n`, "utf8");
            await fs.rename(temporary, target);
            res.json({ ...brainConfig(runtime), message: "Brain configuration saved and applied." });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/embeddings/config", async (req, res) => {
        try {
            const embedding = validateEmbeddingRuntime(req.body);
            runtime.config.embeddingRuntime = embedding;
            const target = modelProcessorConfigPath(config.genesisRuntimePath);
            const temporary = `${target}.tmp`;
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(temporary, `${JSON.stringify({
                processors: runtime.config.modelRuntime.processors,
                roles: runtime.config.modelRuntime.roles,
                embedding
            }, null, 2)}\n`, "utf8");
            await fs.rename(temporary, target);
            res.json({ ok: true, embedding: structuredClone(embedding), message: "Embedding encoder saved and applied." });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/brains/discover", async (req, res) => {
        try {
            const baseUrl = String(req.body?.baseUrl ?? "").trim().replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(baseUrl))
                throw new TypeError("A valid endpoint URL is required");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5_000);
            try {
                // An NLI sidecar lists the models it has loaded; any other endpoint is
                // asked as Ollama is.
                if (String(req.body?.provider ?? "") === "nli") {
                    const health = await fetch(`${baseUrl}/health`, { signal: controller.signal });
                    if (!health.ok)
                        throw new Error(`NLI sidecar returned HTTP ${health.status}`);
                    const payload = await health.json();
                    res.json({ ok: true, models: (Array.isArray(payload?.loaded) ? payload.loaded : []).map((name) => ({ name: String(name), size: 0, parameters: "", contextSize: 512 })) });
                    return;
                }
                const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
                if (!response.ok)
                    throw new Error(`Endpoint returned HTTP ${response.status}`);
                const payload = await response.json();
                const models = Array.isArray(payload?.models) ? payload.models.map((model) => ({
                    name: String(model?.name ?? model?.model ?? ""),
                    size: Number(model?.size ?? 0),
                    parameters: String(model?.details?.parameter_size ?? ""),
                    contextSize: Number(model?.details?.context_length ?? 0)
                })).filter((model) => model.name) : [];
                res.json({ ok: true, models });
            }
            finally {
                clearTimeout(timeout);
            }
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/tools/config", (_req, res) => res.json(toolConfig(runtime, state)));
    app.post("/api/tools/config", async (req, res) => {
        state.toolApprovals = req.body?.toolApprovals && typeof req.body.toolApprovals === "object"
            ? Object.fromEntries(Object.entries(req.body.toolApprovals).map(([name, value]) => [name, value !== false]))
            : state.toolApprovals;
        await saveState();
        res.json({ ...toolConfig(runtime, state), message: "Tool approvals saved." });
    });
    app.get("/api/browser/config", (_req, res) => res.json({ ok: true, browser: runtime.config.browserRuntime }));
    app.post("/api/browser/config", async (req, res) => {
        try {
            const browser = validateBrowserRuntime(req.body);
            runtime.config.browserRuntime = browser;
            const target = browserRuntimeConfigPath(config.genesisRuntimePath);
            const temporary = `${target}.tmp`;
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(temporary, `${JSON.stringify(browser, null, 2)}\n`, "utf8");
            await fs.rename(temporary, target);
            res.json({ ok: true, browser, message: "Web browser configuration saved and applied." });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/browser/test", async (_req, res) => {
        try {
            const health = await playwrightHealth(runtime.config.browserRuntime);
            res.json({ ok: true, health });
        }
        catch (error) {
            res.status(502).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/secrets", async (_req, res) => {
        try {
            res.json({ ok: true, secrets: await options.secretStore.list() });
        }
        catch (error) {
            res.status(500).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/secrets", async (req, res) => {
        try {
            const secret = await options.secretStore.set(String(req.body?.handle ?? ""), String(req.body?.value ?? ""));
            res.json({ ok: true, secret, secrets: await options.secretStore.list(), message: `Secret ${secret.handle} saved.` });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.delete("/api/secrets/:handle", async (req, res) => {
        try {
            const deleted = await options.secretStore.delete(String(req.params.handle ?? ""));
            res.json({ ok: true, deleted, secrets: await options.secretStore.list() });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/agent-skills", (_req, res) => res.json({ ok: true, skills: [] }));
    app.get("/api/memory/admission", (_req, res) => res.json({ ok: true, policy: state.memoryAdmission }));
    app.post("/api/memory/admission", async (req, res) => {
        state.memoryAdmission = normalizeMemoryAdmissionPolicy(req.body?.policy);
        runtime.memoryAdmissionPolicy = { ...state.memoryAdmission };
        await saveState();
        res.json({ ok: true, policy: state.memoryAdmission, message: "Memory admission settings saved and applied." });
    });
}
//# sourceMappingURL=config.js.map