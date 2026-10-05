import { loadConfig } from "../config.js";
import { buildContextPacket } from "../context/builder.js";
import { SpeckDatabase } from "../persistence/database.js";
import { EpisodeRepository } from "../persistence/episode-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import { MentalObjectRepository } from "../persistence/mental-object-repository.js";
import { WorkerRepository } from "../persistence/worker-repository.js";
import { DEFAULT_MEMORY_ADMISSION_POLICY } from "../memory/admission.js";
import { createConfiguredProcessor } from "../models/providers.js";
import { ModelRegistry } from "../models/registry.js";
import { TierScheduler } from "../models/escalation.js";
import { ToolRegistry } from "../tools/registry.js";
import { Toolbelt } from "./services/toolbelt.js";
import { emptyMetacognitiveState } from "../metacognition/assessment.js";
import { readParallelPlan } from "../coordination/planner.js";
import { BackgroundScheduler } from "../background/scheduler.js";
import { createWorkerId } from "../types/ids.js";
import { WORKER_STATUSES } from "../types/model.js";
import { EventBus } from "./event-bus.js";
import path from "node:path";
import { ProcessorCompetenceStore } from "../metacognition/competence.js";
import { assertTransition, INTERRUPTIBLE_STATUSES } from "./state-machine.js";
import { Telemetry } from "./telemetry.js";
import { bounded, RuntimeCore } from "./core.js";
import { InferenceService } from "./services/inference.js";
import { PredictionService } from "./services/predictions.js";
import { ToolIntentService } from "./services/tool-intents.js";
import { MemoryService } from "./services/memory.js";
import { WorkspaceService } from "./services/workspace.js";
import { BeliefService } from "./services/belief.js";
import { MetacognitionService } from "./services/metacognition.js";
import { ProcedureService } from "./services/procedures.js";
import { CoordinationService } from "./services/coordination.js";
import { BackgroundCognitionService } from "./services/background.js";
export { NoApplicableToolError } from "./services/tool-intents.js";
export class SpeckRuntime {
    config;
    database;
    // A conversation's episodes (see src/runtime/conversation.ts).
    episodes;
    workers;
    mentalObjects;
    events;
    eventBus;
    modelRegistry = new ModelRegistry();
    processorCompetence;
    toolRegistry = new ToolRegistry();
    // The tools put in front of the Tool Caller for each message (S32).
    toolbelt = new Toolbelt(() => this.config.embeddingRuntime);
    telemetry = new Telemetry();
    tierScheduler;
    backgroundScheduler = new BackgroundScheduler();
    memoryAdmissionPolicy = { ...DEFAULT_MEMORY_ADMISSION_POLICY };
    core;
    // The domain services; the facade's methods delegate to them. Services
    // reach each other through these.
    inference;
    predictions;
    toolIntents;
    memory;
    workspace;
    belief;
    metacognition;
    procedures;
    coordination;
    background;
    closed = false;
    constructor(config = {}) {
        this.config = loadConfig(config);
        this.database = new SpeckDatabase(this.config.databasePath);
        this.workers = new WorkerRepository(this.database.connection);
        this.episodes = new EpisodeRepository(this.database);
        this.mentalObjects = new MentalObjectRepository(this.database.connection);
        this.events = new EventRepository(this.database.connection);
        this.eventBus = new EventBus(this.events);
        this.tierScheduler = new TierScheduler(this.config.modelEscalation.tierConcurrency);
        this.processorCompetence = new ProcessorCompetenceStore(this.config.databasePath === ":memory:" ? null
            : this.config.modelRuntime.competencePath ?? path.join(path.dirname(this.config.databasePath), "processor-competence.json"));
        this.core = new RuntimeCore(this.config, this.database, this.workers, this.mentalObjects, this.events, this.eventBus, this.telemetry);
        this.inference = new InferenceService(this.core, this, this.modelRegistry, this.processorCompetence);
        this.predictions = new PredictionService(this.core, this);
        this.toolIntents = new ToolIntentService(this.core, this, this.predictions);
        this.memory = new MemoryService(this.core, this);
        this.workspace = new WorkspaceService(this.core, this);
        this.belief = new BeliefService(this.core, this);
        this.metacognition = new MetacognitionService(this.core, this);
        this.procedures = new ProcedureService(this.core, this);
        this.coordination = new CoordinationService(this.core, this);
        this.background = new BackgroundCognitionService(this.core, this);
        this.modelRegistry.observer = (observation) => this.inference.observeInference(observation);
        for (const descriptor of this.config.modelRuntime.processors) {
            if (descriptor.provider === "genesis")
                continue;
            this.modelRegistry.register(descriptor, createConfiguredProcessor(descriptor));
            this.inference.applyLearnedContextWindow(descriptor.id);
        }
        this.telemetry.gauge("workers.total", this.workers.list().length);
    }
    async initialize() {
        const recovered = this.config.recoverInterruptedWorkers ? await this.recoverInterruptedWorkers() : [];
        const recoveredToolExecutions = this.config.toolRuntime.recoverInterruptedExecutions
            ? await this.toolIntents.recoverInterruptedToolExecutions() : 0;
        return { recovered, recoveredToolExecutions };
    }
    async createWorker(objective, constraints = [], actor = {}) {
        const description = objective.trim();
        if (!description)
            throw new TypeError("Worker objective is required");
        const now = new Date().toISOString();
        const worker = {
            id: createWorkerId(),
            objective: { description, constraints: constraints.map(String) },
            status: "created",
            workingMemory: [], commitments: [], beliefs: [], hypotheses: [], evidence: [],
            worldState: {}, currentStrategy: null, currentProcedure: null, modelAssignment: null,
            progress: { cycle: 0, lastProgressAt: null, score: 0 },
            confidence: { overall: 0.5, calibrated: null },
            operationalState: { mode: "normal", pressure: 0 },
            openQuestions: [], impasses: [], metacognition: emptyMetacognitiveState(), recovery: { interruptedFrom: null, recoveredAt: null },
            coordination: null,
            createdAt: now, updatedAt: now, revision: 0
        };
        const event = this.makeEvent(worker.id, "worker.created", { objective: worker.objective }, actor, now);
        const persistedEvent = this.database.transaction(() => {
            this.workers.insert(worker);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("workers.created");
        this.telemetry.gauge("workers.total", this.workers.list().length);
        return worker;
    }
    async transitionWorker(id, to, actor = {}, reason = "") {
        if (!WORKER_STATUSES.includes(to))
            throw new TypeError(`Unknown worker status: ${String(to)}`);
        const current = this.workers.require(id);
        assertTransition(current.status, to);
        const now = new Date().toISOString();
        const updated = { ...current, status: to, updatedAt: now, revision: current.revision + 1 };
        const event = this.makeEvent(id, "worker.transitioned", { from: current.status, to, reason }, actor, now);
        const persistedEvent = this.database.transaction(() => {
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("workers.transitions");
        return updated;
    }
    async createMentalObject(input) {
        if (input.workerId)
            this.workers.require(input.workerId);
        const now = new Date().toISOString();
        const object = this.makeMentalObjectRecord({
            workerId: input.workerId ?? null,
            kind: input.kind,
            content: input.content,
            data: input.data ?? {},
            confidence: input.confidence ?? 0.5,
            importance: input.importance ?? 0.5,
            memoryRoles: input.memoryRoles ?? [],
            actor: input.actor ?? {}
        }, now);
        const event = this.makeEvent(object.workerId, "mental-object.created", { objectId: object.id, kind: object.kind }, input.actor ?? {}, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.insert(object);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("mental_objects.created");
        return object;
    }
    async recordMemory(input) {
        if (input.type !== "episodic" && input.type !== "semantic")
            throw new TypeError(`Unknown memory type: ${String(input.type)}`);
        const kind = input.type === "episodic" ? "observation" : "fact";
        return this.createAttachedObject({
            workerId: input.workerId, kind, content: input.content, data: input.data,
            confidence: input.confidence, importance: input.importance,
            memoryRoles: [input.type], workerField: null, eventType: "memory.recorded",
            eventPayload: { memoryType: input.type }, actor: input.actor
        });
    }
    recordSharedMemory(...args) { return this.memory.recordSharedMemory(...args); }
    retrieveSharedMemories(...args) { return this.memory.retrieveSharedMemories(...args); }
    importSharedMemories(...args) { return this.memory.importSharedMemories(...args); }
    archiveSharedMemory(...args) { return this.memory.archiveSharedMemory(...args); }
    admitToWorkingMemory(...args) { return this.workspace.admitToWorkingMemory(...args); }
    createCommitment(...args) { return this.belief.createCommitment(...args); }
    updateCommitment(...args) { return this.belief.updateCommitment(...args); }
    async setWorldState(input) {
        const key = input.key.trim();
        if (!key)
            throw new TypeError("World-state key is required");
        if (!["observed", "inferred", "assumed", "unknown"].includes(input.epistemicStatus)) {
            throw new TypeError(`Unknown epistemic status: ${input.epistemicStatus}`);
        }
        const current = this.workers.require(input.workerId);
        const now = new Date().toISOString();
        const entry = {
            key, value: input.value, epistemicStatus: input.epistemicStatus,
            confidence: bounded(input.confidence ?? (input.epistemicStatus === "observed" ? 1 : 0.5), "confidence"),
            provenance: this.makeProvenance(input.actor ?? {}, now),
            observedAt: input.observedAt ?? now, updatedAt: now
        };
        const updated = {
            ...current, worldState: { ...current.worldState, [key]: entry },
            updatedAt: now, revision: current.revision + 1
        };
        const event = this.makeEvent(input.workerId, "world-state.changed", {
            key, epistemicStatus: entry.epistemicStatus, previous: current.worldState[key] ?? null
        }, input.actor ?? {}, now);
        const persistedEvent = this.database.transaction(() => {
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        return entry;
    }
    recordEvidence(...args) { return this.belief.recordEvidence(...args); }
    reviseHypothesesFromEvidence(...args) { return this.belief.reviseHypothesesFromEvidence(...args); }
    rankHypotheses(...args) { return this.belief.rankHypotheses(...args); }
    proposeHypothesis(...args) { return this.belief.proposeHypothesis(...args); }
    restateHypothesis(...args) { return this.belief.restateHypothesis(...args); }
    withdrawEvidence(...args) { return this.belief.withdrawEvidence(...args); }
    completeCycle(...args) { return this.metacognition.completeCycle(...args); }
    recordModelOutcome(...args) { return this.metacognition.recordModelOutcome(...args); }
    resolveImpasse(...args) { return this.metacognition.resolveImpasse(...args); }
    consultOnImpasse(...args) { return this.metacognition.consultOnImpasse(...args); }
    recordProcedureDemonstration(...args) { return this.procedures.recordProcedureDemonstration(...args); }
    executeProcedure(...args) { return this.procedures.executeProcedure(...args); }
    recordKnownAnswer(...args) { return this.procedures.recordKnownAnswer(...args); }
    retrieveKnownAnswer(...args) { return this.procedures.retrieveKnownAnswer(...args); }
    competeForWorkingMemory(...args) { return this.workspace.competeForWorkingMemory(...args); }
    buildContext(input) {
        if (!this.config.contextEngine.contextBuilderEnabled)
            throw new TypeError("Context builder is disabled");
        if (input.tokenBudget !== undefined && (!Number.isFinite(input.tokenBudget) || input.tokenBudget <= 0)) {
            throw new RangeError("tokenBudget must be a positive finite number");
        }
        const worker = this.workers.require(input.workerId);
        const packet = buildContextPacket({
            worker,
            objects: this.mentalObjects.listForWorker(input.workerId),
            config: this.config.contextEngine,
            ...(input.expectedOutputContract === undefined ? {} : { expectedOutputContract: input.expectedOutputContract }),
            ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
            ...(input.scope === undefined ? {} : { scope: input.scope })
        });
        this.telemetry.increment("context.packets");
        this.telemetry.increment("context.estimated_tokens", packet.estimatedTokens);
        return packet;
    }
    registerModelProcessor(descriptor, processor) {
        this.modelRegistry.upsert(descriptor, processor);
    }
    async assignModelProcessor(workerId, processorId, actor = {}) {
        const current = this.workers.require(workerId);
        const processor = this.modelRegistry.select({ id: processorId });
        const now = new Date().toISOString();
        const updated = {
            ...current,
            modelAssignment: { processorId: processor.id, tier: processor.tier },
            updatedAt: now,
            revision: current.revision + 1
        };
        const event = this.makeEvent(workerId, "model.assigned", {
            previous: current.modelAssignment,
            processorId: processor.id,
            tier: processor.tier
        }, actor, now);
        const persistedEvent = this.database.transaction(() => {
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        return updated;
    }
    inferForWorker(...args) { return this.inference.inferForWorker(...args); }
    recordJudgment(...args) { return this.inference.recordJudgment(...args); }
    independentProcessor(...args) { return this.inference.independentProcessor(...args); }
    independentProcessors(...args) { return this.inference.independentProcessors(...args); }
    qualifiedProcessor(...args) { return this.inference.qualifiedProcessor(...args); }
    processorForRole(...args) { return this.inference.processorForRole(...args); }
    groundFacts(...args) { return this.memory.groundFacts(...args); }
    proposeToolIntent(...args) { return this.toolIntents.proposeToolIntent(...args); }
    createPrediction(...args) { return this.predictions.createPrediction(...args); }
    comparePredictionToObservation(...args) { return this.predictions.comparePredictionToObservation(...args); }
    executeToolIntent(...args) { return this.toolIntents.executeToolIntent(...args); }
    reinforceMemoryReference(...args) { return this.memory.reinforceMemoryReference(...args); }
    reinforceAssociation(...args) { return this.memory.reinforceAssociation(...args); }
    retrieveMemories(...args) { return this.memory.retrieveMemories(...args); }
    linkMemoryToDomain(...args) { return this.memory.linkMemoryToDomain(...args); }
    retrieveDomainMemories(...args) { return this.memory.retrieveDomainMemories(...args); }
    createParallelPlan(...args) { return this.coordination.createParallelPlan(...args); }
    getParallelPlan(...args) { return this.coordination.getParallelPlan(...args); }
    sendWorkerMessage(...args) { return this.coordination.sendWorkerMessage(...args); }
    shareEvidence(...args) { return this.coordination.shareEvidence(...args); }
    reportSubtask(...args) { return this.coordination.reportSubtask(...args); }
    aggregateParallelPlan(...args) { return this.coordination.aggregateParallelPlan(...args); }
    beginForegroundWork(...args) { return this.background.beginForegroundWork(...args); }
    runBackgroundCognition(...args) { return this.background.runBackgroundCognition(...args); }
    getCognitiveState(workerId) {
        const worker = this.workers.require(workerId);
        const objects = this.mentalObjects.listForWorker(workerId);
        const byId = new Map(objects.map((object) => [object.id, object]));
        return {
            worker,
            workingMemory: worker.workingMemory.map((id) => byId.get(id)).filter(Boolean),
            episodicMemory: objects.filter((object) => object.memoryRoles.includes("episodic")),
            semanticMemory: objects.filter((object) => object.memoryRoles.includes("semantic")),
            commitments: worker.commitments.map((id) => byId.get(id)).filter(Boolean),
            beliefs: worker.beliefs.map((id) => byId.get(id)).filter(Boolean),
            evidence: worker.evidence.map((id) => byId.get(id)).filter(Boolean),
            hypotheses: this.rankHypotheses(workerId),
            impasses: worker.impasses.map((id) => byId.get(id)).filter(Boolean),
            procedures: objects.filter((object) => object.kind === "procedure"),
            knownAnswers: objects.filter((object) => object.kind === "known-answer"),
            plans: objects.filter((object) => readParallelPlan(object) !== null),
            inbox: objects.filter((object) => object.data.schema === "speck.worker-message.v1"),
            sharedEvidence: objects.filter((object) => object.kind === "evidence" && object.data.sharedEvidence === true),
            worldState: worker.worldState
        };
    }
    getWorker(id) { return this.workers.get(id); }
    listWorkers(status) { return this.workers.list(status); }
    listEvents(workerId, afterSequence = 0, limit = 100) {
        return workerId ? this.events.listForWorker(workerId, afterSequence, limit) : this.events.listAll(afterSequence, limit);
    }
    close() {
        if (!this.closed) {
            this.database.close();
            this.closed = true;
        }
    }
    async recoverInterruptedWorkers() {
        const interrupted = this.workers.list().filter((worker) => INTERRUPTIBLE_STATUSES.includes(worker.status));
        const recovered = [];
        for (const current of interrupted) {
            const now = new Date().toISOString();
            const updated = {
                ...current,
                status: "ready",
                recovery: { interruptedFrom: current.status, recoveredAt: now },
                updatedAt: now,
                revision: current.revision + 1
            };
            const event = this.makeEvent(current.id, "worker.recovered", { from: current.status, to: "ready" }, {
                kind: "recovery", source: "startup-recovery"
            }, now);
            const persistedEvent = this.database.transaction(() => {
                this.workers.update(updated, current.revision);
                return this.eventBus.persist(event);
            });
            await this.eventBus.dispatch(persistedEvent);
            recovered.push(updated);
            this.telemetry.increment("workers.recovered");
        }
        return recovered;
    }
    makeEvent(...args) { return this.core.makeEvent(...args); }
    makeProvenance(...args) { return this.core.makeProvenance(...args); }
    makeMentalObjectRecord(...args) { return this.core.makeMentalObjectRecord(...args); }
    requireOwnedObject(...args) { return this.core.requireOwnedObject(...args); }
    createAttachedObject(...args) { return this.core.createAttachedObject(...args); }
}
//# sourceMappingURL=speck-runtime.js.map