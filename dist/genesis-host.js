import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createAdminSecurity } from "genesis-runtime/admin-security";
import { createHttpHooks } from "genesis-runtime/http-hooks";
import { initializePluginManager } from "genesis-runtime/plugin-loader";
import { loadActiveProfile } from "genesis-runtime/profile-manager";
import { registerSpeckRoutes, sendSpeckError } from "./api/routes.js";
import { parseMentalObjectId, parseWorkerId } from "./types/ids.js";
import { registerGenesisBrainProcessors } from "./models/genesis.js";
import { registerGenesisTools } from "./tools/genesis.js";
import { registerSpeckCoreTools } from "./tools/core.js";
import { STANDARD_TASK_SUITE } from "./benchmark/suites.js";
import { createStandardVariants } from "./benchmark/ablations.js";
import { BENCHMARK_HARNESS_VERSION } from "./benchmark/harness.js";
import { registerGenesisUi } from "./genesis-ui.js";
import { SecretStore } from "./security/secret-store.js";
export async function createGenesisSpeckHost(runtime, config, options = {}) {
    const app = express();
    const startedAt = Date.now();
    const speckRoot = path.resolve(options.speckRoot ?? ".");
    app.disable("x-powered-by");
    app.use(express.json({ limit: "5mb" }));
    app.use("/vendor/fonts", express.static(path.join(speckRoot, "node_modules", "@fontsource")));
    app.use("/vendor/three", express.static(path.join(speckRoot, "node_modules", "three")));
    app.use("/observer-compat", express.static(path.join(speckRoot, "observer-compat")));
    app.use(express.static(path.join(speckRoot, "public")));
    app.use((req, res, next) => {
        if (req.path === "/api/speck/background/run")
            return next();
        const release = runtime.beginForegroundWork();
        res.once("finish", release);
        res.once("close", release);
        return next();
    });
    const adminSecurity = createAdminSecurity({ port: config.port });
    adminSecurity.registerAdminSecurityMiddleware(app);
    await fs.mkdir(config.genesisRuntimePath, { recursive: true });
    const secretStore = new SecretStore(config.genesisRuntimePath);
    await registerSpeckCoreTools(runtime, path.join(config.genesisRuntimePath, "workspace"));
    const profilePreferencePath = path.join(config.genesisRuntimePath, "profile-selection.json");
    const hasSavedProfile = await fs.access(profilePreferencePath).then(() => true, () => false);
    const profileEnv = { ...process.env };
    if (!hasSavedProfile || process.env.SPECK_GENESIS_PROFILE)
        profileEnv.GENESIS_PROFILE = config.genesisProfile;
    const profile = await loadActiveProfile({
        fs,
        rootDir: speckRoot,
        preferencePath: profilePreferencePath,
        env: profileEnv,
        logger: console
    });
    const hostCapabilities = buildHostCapabilities(runtime, secretStore);
    const externalPluginDirectory = process.env.GENESIS_PLUGIN_DIR;
    delete process.env.GENESIS_PLUGIN_DIR;
    let initialized;
    try {
        initialized = await initializePluginManager({
            app,
            broadcast: (message) => console.log(String(message ?? "")),
            fs,
            getAppConfig: () => ({ speck: { phase: 13 } }),
            pathModule: path,
            profile,
            externalPluginImportMode: config.pluginImportMode,
            hostCapabilities,
            // Genesis always inspects <root>/plugins and <runtime>/modules. Keeping
            // both roots below Speck/plugins makes this the sole plugin boundary.
            pluginRuntimeRoot: path.join(speckRoot, "plugins", ".runtime"),
            rootDir: speckRoot,
            runtimeContext: { speck: runtime },
            validateAdminRequest: adminSecurity.validateAdminRequest
        });
    }
    finally {
        if (externalPluginDirectory === undefined)
            delete process.env.GENESIS_PLUGIN_DIR;
        else
            process.env.GENESIS_PLUGIN_DIR = externalPluginDirectory;
    }
    const { pluginManager, pluginLoadErrors } = initialized;
    try {
        registerGenesisTools(runtime.toolRegistry, pluginManager);
    }
    catch (error) {
        pluginLoadErrors.push(`[speck-tool-runtime] ${error instanceof Error ? error.message : String(error)}`);
    }
    const listBrains = pluginManager.getCapability("brain:list");
    const generateWithBrain = pluginManager.getCapability("brain:generate");
    if (typeof listBrains === "function" && typeof generateWithBrain === "function") {
        try {
            await registerGenesisBrainProcessors({ registry: runtime.modelRegistry, listBrains, generate: generateWithBrain });
        }
        catch (error) {
            pluginLoadErrors.push(`[speck-model-runtime] ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const uiBridge = await registerGenesisUi(app, runtime, config, {
        speckRoot,
        profile,
        profileRoot: speckRoot,
        startedAt,
        secretStore
    });
    const httpHooks = createHttpHooks({ getPluginManager: () => pluginManager });
    app.use(httpHooks.requestTrackingMiddleware);
    registerSpeckRoutes(app, runtime);
    app.post("/api/speck/intake", async (req, res) => {
        try {
            const request = String(req.body?.request ?? "").trim();
            if (!request)
                throw new TypeError("Intake request is required");
            const correlationId = String(req.body?.correlationId ?? "").trim() || undefined;
            const received = await pluginManager.runHook("intake:received", {
                request,
                objective: request,
                constraints: Array.isArray(req.body?.constraints) ? req.body.constraints.map(String) : [],
                sessionId: String(req.body?.sessionId ?? "Main"),
                correlationId,
                metadata: req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}
            });
            if (received?.handled === true) {
                res.json({ ok: true, handled: true, result: received.result ?? null });
                return;
            }
            const worker = await runtime.createWorker(String(received?.objective ?? received?.request ?? request), Array.isArray(received?.constraints) ? received.constraints.map(String) : [], { kind: "user", source: "genesis-intake", correlationId: received?.correlationId ?? correlationId ?? null });
            const completed = await pluginManager.runHook("intake:worker-created", { ...received, worker });
            res.status(201).json({ ok: true, handled: false, worker, intake: completed });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    await pluginManager.registerRoutes();
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    return {
        app,
        pluginManager,
        pluginLoadErrors,
        profile,
        async close() {
            await uiBridge.close();
            await pluginManager.shutdown("speck-host-shutdown");
        }
    };
}
function buildHostCapabilities(runtime, secretStore) {
    return {
        "speck:secret-list": () => secretStore.list(),
        "speck:secret-has": ({ handle } = {}) => secretStore.has(String(handle ?? "")),
        "speck:secret-get": ({ handle } = {}) => secretStore.get(String(handle ?? "")),
        "speck:secret-set": ({ handle, value } = {}) => secretStore.set(String(handle ?? ""), String(value ?? "")),
        "speck:secret-delete": ({ handle } = {}) => secretStore.delete(String(handle ?? "")),
        "speck:worker-create": ({ objective, constraints = [], actorId = null } = {}) => runtime.createWorker(String(objective ?? ""), constraints.map(String), { kind: "user", source: "genesis-capability", actorId }),
        "speck:worker-get": ({ id } = {}) => runtime.getWorker(parseWorkerId(String(id ?? ""))),
        "speck:worker-list": ({ status } = {}) => runtime.listWorkers(status),
        "speck:cognition-state": ({ workerId } = {}) => runtime.getCognitiveState(parseWorkerId(String(workerId ?? ""))),
        "speck:memory-record": (input = {}) => runtime.recordMemory({ ...input, workerId: parseWorkerId(String(input.workerId ?? "")) }),
        "speck:memory-reference": ({ workerId, objectId, actor = {} } = {}) => runtime.reinforceMemoryReference(parseWorkerId(String(workerId ?? "")), parseMentalObjectId(String(objectId ?? "")), actor),
        "speck:association-reinforce": (input = {}) => runtime.reinforceAssociation({
            ...input,
            workerId: parseWorkerId(String(input.workerId ?? "")),
            sourceId: parseMentalObjectId(String(input.sourceId ?? "")),
            targetId: parseMentalObjectId(String(input.targetId ?? ""))
        }),
        "speck:memory-retrieve": ({ workerId, anchorIds, excludedIds, ...input } = {}) => runtime.retrieveMemories({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            ...(Array.isArray(anchorIds) ? { anchorIds: anchorIds.map((id) => parseMentalObjectId(String(id))) } : {}),
            ...(Array.isArray(excludedIds) ? { excludedIds: excludedIds.map((id) => parseMentalObjectId(String(id))) } : {})
        }),
        "speck:domain-link": (input = {}) => runtime.linkMemoryToDomain({
            ...input,
            workerId: parseWorkerId(String(input.workerId ?? "")),
            objectId: parseMentalObjectId(String(input.objectId ?? ""))
        }),
        "speck:domain-retrieve": (input = {}) => runtime.retrieveDomainMemories({
            ...input,
            workerId: parseWorkerId(String(input.workerId ?? ""))
        }),
        "speck:working-memory-admit": ({ workerId, objectId, actor = {} } = {}) => runtime.admitToWorkingMemory(parseWorkerId(String(workerId ?? "")), parseMentalObjectId(String(objectId ?? "")), actor),
        "speck:working-memory-compete": ({ workerId, candidateIds, ...input } = {}) => runtime.competeForWorkingMemory({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            ...(Array.isArray(candidateIds) ? { candidateIds: candidateIds.map((id) => parseMentalObjectId(String(id))) } : {})
        }),
        "speck:context-build": ({ workerId, ...input } = {}) => runtime.buildContext({
            ...input,
            workerId: parseWorkerId(String(workerId ?? ""))
        }),
        "speck:model-list": () => runtime.modelRegistry.list(),
        "speck:model-assign": ({ workerId, processorId, actor = {} } = {}) => runtime.assignModelProcessor(parseWorkerId(String(workerId ?? "")), String(processorId ?? ""), actor),
        "speck:model-infer": ({ workerId, ...input } = {}) => runtime.inferForWorker({
            ...input,
            workerId: parseWorkerId(String(workerId ?? ""))
        }),
        "speck:tool-list": () => runtime.toolRegistry.list(),
        "speck:tool-intent": ({ workerId, ...input } = {}) => runtime.proposeToolIntent({
            ...input,
            workerId: parseWorkerId(String(workerId ?? ""))
        }),
        "speck:tool-execute": ({ workerId, ...input } = {}) => runtime.executeToolIntent({
            ...input,
            workerId: parseWorkerId(String(workerId ?? ""))
        }),
        "speck:prediction-create": ({ workerId, ...input } = {}) => runtime.createPrediction({
            ...input,
            workerId: parseWorkerId(String(workerId ?? ""))
        }),
        "speck:prediction-compare": ({ workerId, predictionId, observationId, ...input } = {}) => runtime.comparePredictionToObservation({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            predictionId: parseMentalObjectId(String(predictionId ?? "")),
            observationId: parseMentalObjectId(String(observationId ?? ""))
        }),
        "speck:commitment-create": (input = {}) => runtime.createCommitment({ ...input, workerId: parseWorkerId(String(input.workerId ?? "")) }),
        "speck:world-state-set": (input = {}) => runtime.setWorldState({ ...input, workerId: parseWorkerId(String(input.workerId ?? "")) }),
        "speck:evidence-record": (input = {}) => runtime.recordEvidence({ ...input, workerId: parseWorkerId(String(input.workerId ?? "")) }),
        "speck:hypothesis-propose": (input = {}) => runtime.proposeHypothesis({ ...input, workerId: parseWorkerId(String(input.workerId ?? "")) }),
        "speck:hypothesis-rank": ({ workerId } = {}) => runtime.rankHypotheses(parseWorkerId(String(workerId ?? ""))),
        "speck:belief-revise": ({ workerId, evidenceId, ...input } = {}) => runtime.reviseHypothesesFromEvidence({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            evidenceId: parseMentalObjectId(String(evidenceId ?? ""))
        }),
        "speck:confidence-calibrate": ({ workerId, sourceObjectId, ...input } = {}) => runtime.recordModelOutcome({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            ...(sourceObjectId ? { sourceObjectId: parseMentalObjectId(String(sourceObjectId)) } : {})
        }),
        "speck:impasse-resolve": ({ workerId, impasseId, ...input } = {}) => runtime.resolveImpasse({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            impasseId: parseMentalObjectId(String(impasseId ?? ""))
        }),
        "speck:model-escalate": ({ workerId, impasseId, ...input } = {}) => runtime.consultOnImpasse({
            ...input,
            workerId: parseWorkerId(String(workerId ?? "")),
            impasseId: parseMentalObjectId(String(impasseId ?? ""))
        }),
        "speck:tier-resources": () => runtime.tierScheduler.snapshot(),
        "speck:procedure-learn": ({ workerId, episodeId, ...input } = {}) => runtime.recordProcedureDemonstration({
            ...input, workerId: parseWorkerId(String(workerId ?? "")), episodeId: parseMentalObjectId(String(episodeId ?? ""))
        }),
        "speck:procedure-execute": ({ workerId, ...input } = {}) => runtime.executeProcedure({
            ...input, workerId: parseWorkerId(String(workerId ?? ""))
        }),
        "speck:known-answer-record": ({ workerId, sourceObjectId, ...input } = {}) => runtime.recordKnownAnswer({
            ...input, workerId: parseWorkerId(String(workerId ?? "")), sourceObjectId: parseMentalObjectId(String(sourceObjectId ?? ""))
        }),
        "speck:known-answer-lookup": ({ workerId, query, actor = {} } = {}) => runtime.retrieveKnownAnswer(parseWorkerId(String(workerId ?? "")), String(query ?? ""), actor),
        "speck:plan-create": ({ plannerWorkerId, ...input } = {}) => runtime.createParallelPlan({
            ...input, plannerWorkerId: parseWorkerId(String(plannerWorkerId ?? ""))
        }),
        "speck:plan-get": ({ plannerWorkerId, planId } = {}) => runtime.getParallelPlan(parseWorkerId(String(plannerWorkerId ?? "")), parseMentalObjectId(String(planId ?? ""))),
        "speck:worker-message": ({ senderWorkerId, recipientWorkerId, planId, ...input } = {}) => runtime.sendWorkerMessage({
            ...input, senderWorkerId: parseWorkerId(String(senderWorkerId ?? "")),
            recipientWorkerId: parseWorkerId(String(recipientWorkerId ?? "")), planId: parseMentalObjectId(String(planId ?? ""))
        }),
        "speck:evidence-share": ({ sourceWorkerId, targetWorkerId, planId, evidenceId, ...input } = {}) => runtime.shareEvidence({
            ...input, sourceWorkerId: parseWorkerId(String(sourceWorkerId ?? "")), targetWorkerId: parseWorkerId(String(targetWorkerId ?? "")),
            planId: parseMentalObjectId(String(planId ?? "")), evidenceId: parseMentalObjectId(String(evidenceId ?? ""))
        }),
        "speck:subtask-report": ({ workerId, planId, evidenceIds, ...input } = {}) => runtime.reportSubtask({
            ...input, workerId: parseWorkerId(String(workerId ?? "")), planId: parseMentalObjectId(String(planId ?? "")),
            ...(Array.isArray(evidenceIds) ? { evidenceIds: evidenceIds.map((id) => parseMentalObjectId(String(id))) } : {})
        }),
        "speck:plan-aggregate": ({ plannerWorkerId, planId, ...input } = {}) => runtime.aggregateParallelPlan({
            ...input, plannerWorkerId: parseWorkerId(String(plannerWorkerId ?? "")), planId: parseMentalObjectId(String(planId ?? ""))
        }),
        "speck:background-run": ({ workerId } = {}) => runtime.runBackgroundCognition({
            ...(workerId ? { workerId: parseWorkerId(String(workerId)) } : {})
        }),
        "speck:background-state": () => ({
            config: runtime.config.backgroundCognition,
            active: runtime.backgroundScheduler.backgroundActive,
            foregroundActive: runtime.backgroundScheduler.foregroundActive
        }),
        "speck:benchmark-manifest": ({ processor } = {}) => ({
            harnessVersion: BENCHMARK_HARNESS_VERSION,
            tasks: structuredClone(STANDARD_TASK_SUITE),
            variants: createStandardVariants(processor)
        }),
        "speck:cycle-complete": ({ workerId, ...input } = {}) => runtime.completeCycle(parseWorkerId(String(workerId ?? "")), input)
    };
}
//# sourceMappingURL=genesis-host.js.map