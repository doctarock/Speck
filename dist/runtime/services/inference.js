// Model inference for workers, and the evidence it yields about each
// processor: competence judgments, independent evaluators, protocol choice,
// role routing, and learned context windows.
import { contractInstruction } from "../../models/response.js";
import { calibrateConfidence } from "../../metacognition/calibration.js";
import { NATIVE_VERIFICATION, competenceScore, protocolCapability } from "../../metacognition/competence.js";
import { MAX_OUTPUT_TOKENS } from "../../models/providers.js";
import { RuntimeService } from "../core.js";
export class InferenceService extends RuntimeService {
    runtime;
    modelRegistry;
    processorCompetence;
    constructor(core, runtime, modelRegistry, processorCompetence) {
        super(core);
        this.runtime = runtime;
        this.modelRegistry = modelRegistry;
        this.processorCompetence = processorCompetence;
    }
    async inferForWorker(input) {
        const worker = this.workers.require(input.workerId);
        const selected = this.modelRegistry.select({
            ...(input.processorId ?? worker.modelAssignment?.processorId
                ? { id: input.processorId ?? worker.modelAssignment.processorId }
                : {}),
            ...(input.specialty ? { specialty: input.specialty } : {})
        });
        const safeModelBudget = Math.max(1, Math.floor(selected.contextSize * 0.75));
        const native = Boolean(input.tools?.length && input.contract)
            && await this.chooseProtocol(selected.id, input.contract.name) === "native";
        const context = this.runtime.buildContext({
            workerId: input.workerId,
            expectedOutputContract: native
                ? (input.nativeInstruction ?? input.instruction ?? "").trim()
                : [input.instruction?.trim(), input.contract
                        ? contractInstruction(input.contract) : "Return a concise cognitive response."].filter(Boolean).join("\n"),
            tokenBudget: Math.min(input.tokenBudget ?? this.config.contextEngine.contextTokenBudget, safeModelBudget),
            scope: input.contextScope ?? "full"
        });
        const rawResponse = await this.modelRegistry.infer({
            processorId: selected.id,
            prompt: context.text,
            ...(input.specialty ? { specialty: input.specialty } : {}),
            ...(input.contract ? { contract: input.contract } : {}),
            temperature: input.temperature ?? this.config.modelRuntime.temperature,
            timeoutMs: this.config.modelRuntime.timeoutMs,
            maxAttempts: this.config.modelRuntime.maxAttempts,
            promptIncludesContract: Boolean(input.contract),
            protocol: native ? "native" : "json",
            ...(input.input ? { input: input.input } : {}),
            ...(native ? {
                tools: input.tools, ...(input.system ? { system: input.system } : {}),
                ...(input.fromToolCalls ? { fromToolCalls: input.fromToolCalls } : {})
            } : {})
        });
        const calibrationProfile = worker.confidence.calibration?.[rawResponse.processorId];
        const calibratedConfidence = this.config.metacognition.enabled
            ? calibrateConfidence(rawResponse.confidence, calibrationProfile, this.config.metacognition.calibrationMinimumSamples)
            : rawResponse.confidence;
        const response = { ...rawResponse, confidence: calibratedConfidence };
        const object = await this.runtime.createMentalObject({
            workerId: input.workerId,
            kind: "reflection",
            content: response.text,
            data: {
                modelResponse: {
                    processorId: response.processorId,
                    tier: response.tier,
                    attempts: response.attempts,
                    contract: input.contract?.name ?? null,
                    structured: response.structured,
                    contextTokens: context.estimatedTokens,
                    inputTokens: response.inputTokens,
                    outputTokens: response.outputTokens,
                    reportedConfidence: rawResponse.confidence,
                    calibratedConfidence,
                    calibrationBias: calibrationProfile?.bias ?? 0,
                    calibrationSamples: calibrationProfile?.samples.length ?? 0
                }
            },
            confidence: response.confidence,
            importance: 0.5,
            actor: {
                kind: "model",
                source: response.processorId,
                actorId: response.processorId,
                correlationId: input.actor?.correlationId ?? null
            }
        });
        const completedAt = new Date().toISOString();
        const currentAfterObject = this.workers.require(input.workerId);
        const confidenceWorker = {
            ...currentAfterObject,
            confidence: {
                ...currentAfterObject.confidence,
                overall: rawResponse.confidence,
                calibrated: calibratedConfidence
            },
            updatedAt: completedAt,
            revision: currentAfterObject.revision + 1
        };
        const event = this.makeEvent(input.workerId, "model-completed", {
            objectId: object.id,
            processorId: response.processorId,
            tier: response.tier,
            confidence: calibratedConfidence,
            reportedConfidence: rawResponse.confidence,
            calibrationBias: calibrationProfile?.bias ?? 0,
            attempts: response.attempts
        }, {
            kind: "model", source: response.processorId, actorId: response.processorId,
            correlationId: input.actor?.correlationId ?? null
        }, completedAt);
        const persistedEvent = this.database.transaction(() => {
            this.workers.update(confidenceWorker, currentAfterObject.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("model.calls");
        this.telemetry.increment(`model.tier.${response.tier}.calls`);
        this.telemetry.increment("model.attempts", response.attempts);
        return { response, context, object };
    }
    // Processor competence (src/metacognition/competence.ts). Every attempt the
    // registry makes feeds it; outcomes that only the controller can judge
    // (did the tool run, did the reply validate) are added explicitly.
    observeInference(observation) {
        if (observation.tokens !== null) {
            this.processorCompetence.recordTokens(observation.model, observation.tokens, observation.outcome === "context");
            this.applyLearnedContextWindow(observation.processorId);
        }
        if (observation.contract && (observation.outcome === "usable" || observation.outcome === "contract")) {
            this.processorCompetence.record(observation.model, protocolCapability(observation.contract, observation.protocol), {
                success: observation.outcome === "usable", source: observation.processorId, latencyMs: observation.latencyMs
            });
        }
    }
    // A judgment of a processor's output. The evaluator is another processor,
    // "deterministic" for a directly observed outcome, or null when nothing
    // independent judged; a processor judging its own output is recorded as
    // unobserved (see ProcessorCompetenceStore.judge).
    recordJudgment(input) {
        const evaluator = input.evaluator === null || input.evaluator === "deterministic" ? input.evaluator : this.modelRegistry.modelKey(input.evaluator);
        return this.processorCompetence.judge(this.modelRegistry.modelKey(input.producerId), {
            contract: input.contract, protocol: input.protocol, aspect: input.aspect, evaluator, verdict: input.verdict,
            deterministicOutcome: input.deterministicOutcome ?? null, context: input.context ?? {}
        });
    }
    // Shortcut S8 (docs/COGNITIVE_SHORTCUTS.md).
    // A processor other than the producer to judge its output, preferring the
    // one whose replies to the judging contract have most often been usable.
    // Null when no other model is available.
    independentProcessor(producerId, contract) {
        return this.independentProcessors(producerId, contract)[0] ?? null;
    }
    // Every processor other than the producer, strongest evidence for the
    // judging contract first. The score includes the quality of its judgments
    // where they have been checked, not only whether its replies were usable.
    independentProcessors(producerId, contract) {
        const producer = this.modelRegistry.modelKey(producerId);
        const candidates = this.modelRegistry.generative()
            .filter((processor) => processor.enabled && processor.available && this.modelRegistry.modelKey(processor.id) !== producer)
            .map((processor, order) => ({
            id: processor.id, order,
            score: this.processorCompetence.protocolScore(this.modelRegistry.modelKey(processor.id), contract, "json")
        }));
        candidates.sort((left, right) => right.score - left.score || left.order - right.order);
        return candidates.map((candidate) => candidate.id);
    }
    // The processor to make a judgment of a qualified class about a producer's
    // output: the configured checker if there is one, otherwise the cheapest
    // qualified model; in both cases a different model from the producer's,
    // measured qualified for the class. Null when there is none, and then the
    // judgment is void: no model's verdict on it may move a belief.
    qualifiedProcessor(producerId, capability) {
        const producer = this.modelRegistry.modelKey(producerId);
        const configured = this.config.modelRuntime.roles.checker;
        const qualified = this.modelRegistry.list()
            .filter((processor) => !configured || processor.id === configured)
            .filter((processor) => processor.enabled && processor.available && this.modelRegistry.modelKey(processor.id) !== producer)
            .map((processor) => ({ id: processor.id, measured: this.processorCompetence.qualification(this.modelRegistry.modelKey(processor.id), capability) }))
            .filter((candidate) => candidate.measured?.qualified === true);
        qualified.sort((left, right) => left.measured.meanLatencyMs - right.measured.meanLatencyMs);
        return qualified[0]?.id ?? null;
    }
    // Native tool calling is used when the evidence for it is stronger. A model
    // with no evidence for the contract gets one observation from the provider's
    // test call (Shortcut S7), which is persisted and not repeated.
    async chooseProtocol(processorId, contract) {
        const model = this.modelRegistry.modelKey(processorId);
        if (this.processorCompetence.hasEvidence(model, contract))
            return this.processorCompetence.preferredProtocol(model, contract);
        if (!this.processorCompetence.capability(model, NATIVE_VERIFICATION)) {
            const verified = await (this.modelRegistry.processor(processorId)?.supportsNativeTools?.() ?? Promise.resolve(false));
            this.processorCompetence.record(model, NATIVE_VERIFICATION, { success: verified, source: "provider test call" });
        }
        return competenceScore(this.processorCompetence.capability(model, NATIVE_VERIFICATION)) > 0.5 ? "native" : "json";
    }
    // The processor for a role: the configured one, or under competence routing
    // the one with the strongest evidence once every candidate has enough.
    processorForRole(role) {
        const roles = this.config.modelRuntime.roles;
        const configured = role === "writer" ? roles.writer || roles.worker : roles[role];
        const enabled = this.modelRegistry.generative().filter((processor) => processor.enabled);
        const fallback = configured && this.modelRegistry.has(configured) ? configured : enabled[0]?.id ?? "";
        if (this.config.modelRuntime.routing !== "competence")
            return fallback;
        const contracts = ROLE_CONTRACTS[role];
        const scored = enabled.map((processor) => ({
            id: processor.id, ...this.processorCompetence.roleEvidence(this.modelRegistry.modelKey(processor.id), contracts)
        }));
        // Shortcut S8 (docs/COGNITIVE_SHORTCUTS.md): minimum evidence per candidate.
        const qualified = scored.filter((entry) => entry.observations >= ROUTING_MINIMUM_OBSERVATIONS);
        if (qualified.length < 2)
            return fallback;
        qualified.sort((left, right) => right.score - left.score || Number(right.id === fallback) - Number(left.id === fallback));
        return qualified[0].id;
    }
    // The context window each processor has been seen to need (Shortcut S9).
    applyLearnedContextWindow(processorId) {
        const descriptor = this.config.modelRuntime.processors.find((processor) => processor.id === processorId);
        const processor = this.modelRegistry.processor(processorId);
        if (!descriptor || !processor?.setContextWindow || descriptor.runtimeContextSize)
            return;
        processor.setContextWindow(this.processorCompetence.contextWindow(this.modelRegistry.modelKey(processorId), {
            minimum: MINIMUM_CONTEXT_WINDOW, maximum: descriptor.contextSize, replyReserve: MAX_OUTPUT_TOKENS
        }));
    }
}
// The contracts that show competence in each role.
const ROLE_CONTRACTS = {
    intake: ["speck-intake-route", "speck-disclosure-extraction"],
    planner: ["speck-parallel-plan"],
    worker: ["speck-worker-cycle"],
    writer: ["speck-worker-cycle"],
    toolCaller: ["tool-intent"]
};
// Shortcut S8 (docs/COGNITIVE_SHORTCUTS.md).
const ROUTING_MINIMUM_OBSERVATIONS = 5;
// Shortcut S9 (docs/COGNITIVE_SHORTCUTS.md).
const MINIMUM_CONTEXT_WINDOW = 2_048;
//# sourceMappingURL=inference.js.map