import path from "node:path";
import fs from "node:fs";
import { judgmentOnly } from "./models/types.js";
const DEFAULT_MEMORY_ACTIVATION = {
    baseLevelEnabled: true,
    referenceReinforcementEnabled: true,
    associativeEdgesEnabled: true,
    edgeDecayEnabled: true,
    spreadingActivationEnabled: true,
    inhibitionEnabled: true,
    domainAnchorsEnabled: true,
    referenceLogCapacity: 64,
    decayD: 0.5,
    // ACA LoopConfig default: ln(2) / (14 days in milliseconds).
    edgeDecayRatePerMs: 5.73e-10,
    maxHops: 2,
    retrievalThreshold: -2,
    maxNoise: 0.01,
    hebbianIncrement: 0.15,
    maxEdgeStrength: 1
};
const DEFAULT_CONTEXT_ENGINE = {
    candidateRankingEnabled: true,
    crowdingEnabled: true,
    hysteresisEnabled: true,
    coalitionBundlingEnabled: true,
    contextBuilderEnabled: true,
    coalescenceLearningEnabled: true,
    lateralInhibitionLearningEnabled: true,
    attentionThreshold: -2,
    ignitionThreshold: -1.8,
    crowdingStrength: 0.05,
    lateralInhibitionIncrement: 0.05,
    lateralInhibitionMaxLosers: 8,
    contextTokenBudget: 2_048,
    charsPerToken: 4,
    activationWeight: 1,
    surpriseWeight: 1,
    importanceWeight: 0.25,
    confidenceWeight: 0.1,
    taskRelevanceWeight: 1,
    noveltyWeight: 0.25,
    evidenceValueWeight: 0.5,
    unresolvedPressureWeight: 0.5,
    redundancyWeight: 1
};
const DEFAULT_MODEL_RUNTIME = {
    processors: [],
    roles: { intake: "", planner: "", worker: "", toolCaller: "", specialists: {} },
    maxAttempts: 2,
    timeoutMs: 120_000,
    temperature: 0.2,
    routing: process.env.SPECK_MODEL_ROUTING?.trim() === "competence" ? "competence" : "configured"
};
function defaultModelProcessors() {
    const model = process.env.SPECK_OLLAMA_MODEL?.trim();
    if (!model || /^(1|true|yes)$/i.test(process.env.SPECK_DISABLE_DEFAULT_MODEL ?? ""))
        return [];
    return [{
            id: "local-worker",
            provider: "ollama",
            model,
            baseUrl: process.env.SPECK_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
            tier: 2,
            parameters: 14_800_000_000,
            contextSize: 40_960,
            hardware: "local",
            specialties: ["general", "coding", "planning"],
            enabled: true
        }];
}
export function loadAppConfig(overrides = {}) {
    const genesisRuntimePath = path.resolve(overrides.genesisRuntimePath ?? process.env.SPECK_GENESIS_RUNTIME_PATH ?? path.join("data", "genesis-runtime"));
    const saved = readSavedModelConfiguration(genesisRuntimePath);
    const savedBrowser = readSavedBrowserConfiguration(genesisRuntimePath);
    const processors = overrides.modelRuntime?.processors ?? saved?.processors ?? defaultModelProcessors();
    const fallbackId = processors.find((processor) => processor.enabled && !judgmentOnly(processor))?.id ?? "";
    return loadConfig({
        ...overrides,
        genesisRuntimePath,
        embeddingRuntime: overrides.embeddingRuntime ?? saved?.embedding ?? defaultEmbeddingRuntime(),
        browserRuntime: overrides.browserRuntime ?? savedBrowser ?? defaultBrowserRuntime(),
        modelRuntime: {
            ...(overrides.modelRuntime ?? {}),
            processors,
            roles: overrides.modelRuntime?.roles ?? saved?.roles ?? { intake: fallbackId, planner: fallbackId, worker: fallbackId, toolCaller: fallbackId, specialists: {} }
        }
    });
}
export function modelProcessorConfigPath(genesisRuntimePath) {
    return path.join(genesisRuntimePath, "model-processors.json");
}
export function browserRuntimeConfigPath(genesisRuntimePath) {
    return path.join(genesisRuntimePath, "playwright-browser.json");
}
function readSavedBrowserConfiguration(genesisRuntimePath) {
    try {
        return validateBrowserRuntime(JSON.parse(fs.readFileSync(browserRuntimeConfigPath(genesisRuntimePath), "utf8")));
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function readSavedModelConfiguration(genesisRuntimePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(modelProcessorConfigPath(genesisRuntimePath), "utf8"));
        const processors = validateModelProcessors(parsed?.processors);
        return { processors, roles: validateModelRoles(parsed?.roles, processors), ...(parsed?.embedding ? { embedding: validateEmbeddingRuntime(parsed.embedding) } : {}) };
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function defaultEmbeddingRuntime() {
    return {
        enabled: /^(1|true|yes)$/i.test(process.env.SPECK_EMBEDDING_ENABLED ?? ""),
        provider: process.env.SPECK_EMBEDDING_PROVIDER?.trim() || "ollama",
        baseUrl: process.env.SPECK_EMBEDDING_BASE_URL?.trim() || "http://127.0.0.1:11434",
        model: process.env.SPECK_EMBEDDING_MODEL?.trim() || "nomic-embed-text",
        dimensions: positiveInteger(process.env.SPECK_EMBEDDING_DIMENSIONS, 768),
        timeoutMs: positiveInteger(process.env.SPECK_EMBEDDING_TIMEOUT_MS, 30_000),
        batchSize: positiveInteger(process.env.SPECK_EMBEDDING_BATCH_SIZE, 16),
        ...(process.env.SPECK_EMBEDDING_API_KEY_ENV?.trim() ? { apiKeyEnv: process.env.SPECK_EMBEDDING_API_KEY_ENV.trim() } : {}),
        allowHashFallback: !/^(0|false|no)$/i.test(process.env.SPECK_EMBEDDING_HASH_FALLBACK ?? "true")
    };
}
export function validateEmbeddingRuntime(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("embedding configuration must be an object");
    const input = value;
    const provider = String(input.provider ?? "llama.cpp");
    const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
    const model = String(input.model ?? "").trim();
    if (!["ollama", "openai-compatible", "llama.cpp"].includes(provider))
        throw new TypeError("embedding provider is unsupported");
    if (!/^https?:\/\//i.test(baseUrl))
        throw new TypeError("embedding service requires an HTTP(S) base URL");
    if (!model)
        throw new TypeError("embedding service requires a model");
    return {
        enabled: input.enabled !== false,
        provider,
        baseUrl,
        model,
        dimensions: positiveInteger(input.dimensions, 768),
        timeoutMs: positiveInteger(input.timeoutMs, 30_000),
        batchSize: positiveInteger(input.batchSize, 16),
        ...(String(input.apiKeyEnv ?? "").trim() ? { apiKeyEnv: String(input.apiKeyEnv).trim() } : {}),
        allowHashFallback: input.allowHashFallback !== false,
        ...(input.device === "cpu" || input.device === "gpu" ? { device: input.device } : {})
    };
}
export function defaultBrowserRuntime() {
    return {
        enabled: /^(1|true|yes)$/i.test(process.env.SPECK_BROWSER_ENABLED ?? ""),
        baseUrl: process.env.SPECK_BROWSER_BASE_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:39005",
        timeoutMs: positiveInteger(process.env.SPECK_BROWSER_TIMEOUT_MS, 30_000),
        searchLimit: positiveInteger(process.env.SPECK_BROWSER_SEARCH_LIMIT, 6)
    };
}
export function validateBrowserRuntime(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("browser configuration must be an object");
    const input = value;
    const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+/i.test(baseUrl))
        throw new TypeError("Playwright service requires an absolute HTTP(S) base URL");
    const searchLimit = positiveInteger(input.searchLimit, 6);
    if (searchLimit > 20)
        throw new TypeError("browser search limit must be between 1 and 20");
    return {
        enabled: input.enabled !== false,
        baseUrl,
        timeoutMs: positiveInteger(input.timeoutMs, 30_000),
        searchLimit
    };
}
export function validateModelRoles(value, processors) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    // A judgment-only processor (an NLI cross-encoder) cannot fill a role.
    const enabledIds = new Set(processors.filter((processor) => processor.enabled && !judgmentOnly(processor)).map((processor) => processor.id));
    const fallback = processors.find((processor) => processor.enabled && !judgmentOnly(processor))?.id ?? "";
    const role = (name) => {
        const id = String(input[name] ?? fallback).trim();
        if (id && processors.some((processor) => processor.id === id && judgmentOnly(processor))) {
            throw new TypeError(`${name} role cannot be filled by ${id}: it is a judgment-only processor; use it as the checker`);
        }
        if (id && !enabledIds.has(id))
            throw new TypeError(`${name} role references unavailable processor ${id}`);
        return id;
    };
    // The checker seat is the one a judgment-only processor may take.
    const checker = String(input.checker ?? "").trim();
    if (checker && !processors.some((processor) => processor.id === checker && processor.enabled)) {
        throw new TypeError(`checker role references unavailable processor ${checker}`);
    }
    const specialistInput = input.specialists && typeof input.specialists === "object" && !Array.isArray(input.specialists)
        ? input.specialists : {};
    const specialists = {};
    for (const [specialty, rawId] of Object.entries(specialistInput)) {
        const key = specialty.trim().toLowerCase();
        const id = String(rawId ?? "").trim();
        if (!key || !id)
            continue;
        if (!enabledIds.has(id))
            throw new TypeError(`specialist ${key} references unavailable processor ${id}`);
        specialists[key] = id;
    }
    return {
        intake: role("intake"),
        planner: role("planner"),
        worker: role("worker"),
        ...(String(input.writer ?? "").trim() ? { writer: role("writer") } : {}),
        toolCaller: role("toolCaller"),
        ...(checker ? { checker } : {}),
        specialists
    };
}
export function validateModelProcessors(value) {
    if (!Array.isArray(value))
        throw new TypeError("processors must be an array");
    const ids = new Set();
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new TypeError(`processor ${index + 1} must be an object`);
        const input = entry;
        const id = String(input.id ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        const provider = String(input.provider ?? "ollama");
        const model = String(input.model ?? "").trim();
        const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
        const tier = Number(input.tier);
        const contextSize = Number(input.contextSize);
        if (!id || ids.has(id))
            throw new TypeError(`processor ${index + 1} requires a unique id`);
        if (!["ollama", "openai-compatible", "llama.cpp", "nli"].includes(provider))
            throw new TypeError(`processor ${id} has an unsupported provider`);
        if (!model)
            throw new TypeError(`processor ${id} requires a model`);
        if (!/^https?:\/\//i.test(baseUrl))
            throw new TypeError(`processor ${id} requires an HTTP(S) base URL`);
        if (![1, 2, 3, 4].includes(tier))
            throw new TypeError(`processor ${id} tier must be 1 through 4`);
        if (!Number.isInteger(contextSize) || contextSize < 256)
            throw new TypeError(`processor ${id} requires a valid context size`);
        ids.add(id);
        return {
            id, provider, model, baseUrl, tier: tier, contextSize,
            ...(Number.isFinite(Number(input.parameters)) && Number(input.parameters) > 0 ? { parameters: Number(input.parameters) } : {}),
            ...(Number.isFinite(Number(input.speedTokensPerSecond)) && Number(input.speedTokensPerSecond) > 0 ? { speedTokensPerSecond: Number(input.speedTokensPerSecond) } : {}),
            ...(String(input.apiKeyEnv ?? "").trim() ? { apiKeyEnv: String(input.apiKeyEnv).trim() } : {}),
            ...(Number.isInteger(Number(input.runtimeContextSize)) && Number(input.runtimeContextSize) >= 256
                ? { runtimeContextSize: Math.min(contextSize, Number(input.runtimeContextSize)) } : {}),
            hardware: String(input.hardware ?? "").trim() || "local",
            specialties: Array.isArray(input.specialties) ? input.specialties.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean) : ["general"],
            enabled: input.enabled !== false
        };
    });
}
const DEFAULT_TOOL_RUNTIME = {
    timeoutMs: 120_000,
    evidenceReliability: 0.9,
    recoverInterruptedExecutions: true
};
const DEFAULT_PREDICTIVE_LOOP = {
    enabled: true,
    precisionWindow: 20,
    precisionEpsilon: 0.001,
    defaultPrecision: 1,
    highErrorThreshold: 0.6,
    pressureGain: 0.35,
    pressureRelief: 0.15,
    focusedPressureThreshold: 0.25,
    conservativePressureThreshold: 0.75,
    progressGain: 1
};
const DEFAULT_BELIEF_REVISION = {
    enabled: true,
    supportBonus: 0.2,
    contradictionPenalty: 0.2,
    minConfidenceFloor: 0.05,
    supportedThreshold: 0.6,
    confirmationThreshold: 0.85,
    demotionConfidenceThreshold: 0.15,
    modelReliabilityCeiling: 0.4,
    revisionHistoryCapacity: 100
};
const DEFAULT_METACOGNITION = {
    enabled: true,
    impasseDetectionEnabled: true,
    calibrationWindow: 20,
    calibrationMinimumSamples: 2,
    historyCapacity: 32,
    stagnationCycles: 4,
    repeatedStateThreshold: 3,
    repeatedFailureThreshold: 3,
    patternRepeatThreshold: 2,
    confidenceStagnationEpsilon: 0.02,
    lowConfidenceThreshold: 0.3
};
const DEFAULT_MODEL_ESCALATION = {
    enabled: true,
    maximumTier: 4,
    tierConcurrency: { 1: 4, 2: 2, 3: 1, 4: 1 },
    admitConsultationToWorkingMemory: true
};
const DEFAULT_PROCEDURES = {
    enabled: true,
    compilationThreshold: 3,
    initialUtility: 0.5,
    utilityLearningRate: 0.2,
    deprecationFailureCount: 3,
    deprecationSuccessRate: 0.5,
    knownAnswerMinimumConfidence: 0.8,
    executionHistoryCapacity: 50
};
const DEFAULT_COORDINATION = {
    enabled: true,
    maximumSubtasks: 32
};
const DEFAULT_BACKGROUND_COGNITION = {
    enabled: true,
    maximumOperationsPerSlice: 6,
    maximumItemsPerOperation: 16,
    timeBudgetMs: 25,
    consolidationMinimumEpisodes: 3,
    consolidationMinimumConfidence: 0.6,
    patternMinimumEpisodes: 3,
    embeddingDimensions: 32,
    associationPruneThreshold: 0.01
};
const DEFAULT_EMBEDDING_RUNTIME = {
    enabled: false,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    dimensions: 768,
    timeoutMs: 30_000,
    batchSize: 16,
    allowHashFallback: true
};
export function loadConfig(overrides = {}) {
    const configuredPort = Number(process.env.SPECK_PORT ?? process.env.PORT ?? 4310);
    return {
        databasePath: path.resolve(overrides.databasePath ?? process.env.SPECK_DB_PATH ?? path.join("data", "speck.sqlite")),
        genesisRuntimePath: path.resolve(overrides.genesisRuntimePath ?? process.env.SPECK_GENESIS_RUNTIME_PATH ?? path.join("data", "genesis-runtime")),
        genesisProfile: overrides.genesisProfile ?? process.env.SPECK_GENESIS_PROFILE ?? "minimal",
        pluginImportMode: overrides.pluginImportMode ?? (/^permissive$/i.test(process.env.SPECK_PLUGIN_IMPORT_MODE ?? "") ? "permissive" : "allowlist"),
        host: overrides.host ?? process.env.SPECK_HOST ?? "127.0.0.1",
        port: overrides.port ?? (Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 4310),
        workingMemoryCapacity: overrides.workingMemoryCapacity ?? positiveInteger(process.env.SPECK_WORKING_MEMORY_CAPACITY, 4),
        recoverInterruptedWorkers: overrides.recoverInterruptedWorkers ?? !/^(0|false|no)$/i.test(process.env.SPECK_RECOVER_INTERRUPTED ?? "true"),
        memoryActivation: {
            ...DEFAULT_MEMORY_ACTIVATION,
            ...(overrides.memoryActivation ?? {})
        },
        contextEngine: {
            ...DEFAULT_CONTEXT_ENGINE,
            ...(overrides.contextEngine ?? {})
        },
        modelRuntime: {
            ...DEFAULT_MODEL_RUNTIME,
            ...(overrides.modelRuntime ?? {}),
            processors: overrides.modelRuntime?.processors ?? DEFAULT_MODEL_RUNTIME.processors,
            roles: { ...DEFAULT_MODEL_RUNTIME.roles, ...(overrides.modelRuntime?.roles ?? {}), specialists: { ...(overrides.modelRuntime?.roles?.specialists ?? {}) } }
        },
        toolRuntime: {
            ...DEFAULT_TOOL_RUNTIME,
            ...(overrides.toolRuntime ?? {})
        },
        predictiveLoop: {
            ...DEFAULT_PREDICTIVE_LOOP,
            ...(overrides.predictiveLoop ?? {})
        },
        beliefRevision: {
            ...DEFAULT_BELIEF_REVISION,
            ...(overrides.beliefRevision ?? {})
        },
        metacognition: {
            ...DEFAULT_METACOGNITION,
            ...(overrides.metacognition ?? {})
        },
        modelEscalation: {
            ...DEFAULT_MODEL_ESCALATION,
            ...(overrides.modelEscalation ?? {}),
            tierConcurrency: {
                ...DEFAULT_MODEL_ESCALATION.tierConcurrency,
                ...(overrides.modelEscalation?.tierConcurrency ?? {})
            }
        },
        procedures: {
            ...DEFAULT_PROCEDURES,
            ...(overrides.procedures ?? {})
        },
        coordination: {
            ...DEFAULT_COORDINATION,
            ...(overrides.coordination ?? {})
        },
        backgroundCognition: {
            ...DEFAULT_BACKGROUND_COGNITION,
            ...(overrides.backgroundCognition ?? {})
        },
        embeddingRuntime: {
            ...DEFAULT_EMBEDDING_RUNTIME,
            ...(overrides.embeddingRuntime ?? {})
        },
        browserRuntime: {
            ...defaultBrowserRuntime(),
            ...(overrides.browserRuntime ?? {})
        }
    };
}
function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
//# sourceMappingURL=config.js.map