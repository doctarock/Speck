import type { SpeckConfig, SpeckConfigOverrides } from "../config.js";
import { loadConfig } from "../config.js";
import { buildContextPacket, type ContextPacket } from "../context/builder.js";
import { SpeckDatabase } from "../persistence/database.js";
import { EpisodeRepository } from "../persistence/episode-repository.js";
import { EventRepository } from "../persistence/event-repository.js";
import { MentalObjectRepository } from "../persistence/mental-object-repository.js";
import { WorkerRepository } from "../persistence/worker-repository.js";
import { DEFAULT_MEMORY_ADMISSION_POLICY, type MemoryAdmissionPolicy } from "../memory/admission.js";
import { createConfiguredProcessor } from "../models/providers.js";
import { ModelRegistry } from "../models/registry.js";
import { TierScheduler } from "../models/escalation.js";
import type { ModelProcessor, ModelProcessorDescriptor } from "../models/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { Toolbelt } from "./services/toolbelt.js";
import { emptyMetacognitiveState } from "../metacognition/assessment.js";
import { readParallelPlan } from "../coordination/planner.js";
import { BackgroundScheduler } from "../background/scheduler.js";
import { createWorkerId, type WorkerId } from "../types/ids.js";
import type { CognitiveEvent, EpistemicStatus, MentalObject, MentalObjectKind, Worker, WorkerStatus, WorldStateEntry } from "../types/model.js";
import { WORKER_STATUSES } from "../types/model.js";
import { EventBus } from "./event-bus.js";
import path from "node:path";
import { ProcessorCompetenceStore } from "../metacognition/competence.js";
import { assertTransition, INTERRUPTIBLE_STATUSES } from "./state-machine.js";
import { Telemetry } from "./telemetry.js";
import { bounded, RuntimeCore, type ActorInput } from "./core.js";
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

export type { ActorInput } from "./core.js";
export { NoApplicableToolError } from "./services/tool-intents.js";

export type SharedMemoryAudience = "intake" | "planner" | "worker";
export type SharedMemoryScope = "global" | "project" | "domain" | "session";

export class SpeckRuntime {
  readonly config: SpeckConfig;
  readonly database: SpeckDatabase;
  // A conversation's episodes (see src/runtime/conversation.ts).
  readonly episodes: EpisodeRepository;
  readonly workers: WorkerRepository;
  readonly mentalObjects: MentalObjectRepository;
  readonly events: EventRepository;
  readonly eventBus: EventBus;
  readonly modelRegistry = new ModelRegistry();
  readonly processorCompetence: ProcessorCompetenceStore;
  readonly toolRegistry = new ToolRegistry();
  // The tools put in front of the Tool Caller for each message (S32).
  readonly toolbelt = new Toolbelt(() => this.config.embeddingRuntime);
  readonly telemetry = new Telemetry();
  readonly tierScheduler: TierScheduler;
  readonly backgroundScheduler = new BackgroundScheduler();
  memoryAdmissionPolicy: MemoryAdmissionPolicy = { ...DEFAULT_MEMORY_ADMISSION_POLICY };
  private readonly core: RuntimeCore;
  // The domain services; the facade's methods delegate to them. Services
  // reach each other through these.
  readonly inference: InferenceService;
  readonly predictions: PredictionService;
  readonly toolIntents: ToolIntentService;
  readonly memory: MemoryService;
  readonly workspace: WorkspaceService;
  readonly belief: BeliefService;
  readonly metacognition: MetacognitionService;
  readonly procedures: ProcedureService;
  readonly coordination: CoordinationService;
  readonly background: BackgroundCognitionService;
  private closed = false;

  constructor(config: SpeckConfigOverrides = {}) {
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
      if (descriptor.provider === "genesis") continue;
      this.modelRegistry.register(descriptor, createConfiguredProcessor(descriptor));
      this.inference.applyLearnedContextWindow(descriptor.id);
    }
    this.telemetry.gauge("workers.total", this.workers.list().length);
  }

  async initialize(): Promise<{ recovered: Worker[]; recoveredToolExecutions: number }> {
    const recovered = this.config.recoverInterruptedWorkers ? await this.recoverInterruptedWorkers() : [];
    const recoveredToolExecutions = this.config.toolRuntime.recoverInterruptedExecutions
      ? await this.toolIntents.recoverInterruptedToolExecutions() : 0;
    return { recovered, recoveredToolExecutions };
  }

  async createWorker(objective: string, constraints: string[] = [], actor: ActorInput = {}): Promise<Worker> {
    const description = objective.trim();
    if (!description) throw new TypeError("Worker objective is required");
    const now = new Date().toISOString();
    const worker: Worker = {
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

  async transitionWorker(id: WorkerId, to: WorkerStatus, actor: ActorInput = {}, reason = ""): Promise<Worker> {
    if (!WORKER_STATUSES.includes(to)) throw new TypeError(`Unknown worker status: ${String(to)}`);
    const current = this.workers.require(id);
    assertTransition(current.status, to);
    const now = new Date().toISOString();
    const updated: Worker = { ...current, status: to, updatedAt: now, revision: current.revision + 1 };
    const event = this.makeEvent(id, "worker.transitioned", { from: current.status, to, reason }, actor, now);
    const persistedEvent = this.database.transaction(() => {
      this.workers.update(updated, current.revision);
      return this.eventBus.persist(event);
    });
    await this.eventBus.dispatch(persistedEvent);
    this.telemetry.increment("workers.transitions");
    return updated;
  }

  async createMentalObject(input: {
    workerId?: WorkerId | null; kind: MentalObjectKind; content: string;
    data?: Record<string, unknown>; confidence?: number; importance?: number;
    memoryRoles?: MentalObject["memoryRoles"]; actor?: ActorInput;
  }): Promise<MentalObject> {
    if (input.workerId) this.workers.require(input.workerId);
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

  async recordMemory(input: {
    workerId: WorkerId; type: "episodic" | "semantic"; content: string;
    data?: Record<string, unknown> | undefined; confidence?: number | undefined;
    importance?: number | undefined; actor?: ActorInput | undefined;
  }): Promise<MentalObject> {
    if (input.type !== "episodic" && input.type !== "semantic") throw new TypeError(`Unknown memory type: ${String(input.type)}`);
    const kind: MentalObjectKind = input.type === "episodic" ? "observation" : "fact";
    return this.createAttachedObject({
      workerId: input.workerId, kind, content: input.content, data: input.data,
      confidence: input.confidence, importance: input.importance,
      memoryRoles: [input.type], workerField: null, eventType: "memory.recorded",
      eventPayload: { memoryType: input.type }, actor: input.actor
    });
  }

  recordSharedMemory(...args: Parameters<MemoryService["recordSharedMemory"]>) { return this.memory.recordSharedMemory(...args); }

  retrieveSharedMemories(...args: Parameters<MemoryService["retrieveSharedMemories"]>) { return this.memory.retrieveSharedMemories(...args); }

  importSharedMemories(...args: Parameters<MemoryService["importSharedMemories"]>) { return this.memory.importSharedMemories(...args); }

  archiveSharedMemory(...args: Parameters<MemoryService["archiveSharedMemory"]>) { return this.memory.archiveSharedMemory(...args); }

  admitToWorkingMemory(...args: Parameters<WorkspaceService["admitToWorkingMemory"]>) { return this.workspace.admitToWorkingMemory(...args); }

  createCommitment(...args: Parameters<BeliefService["createCommitment"]>) { return this.belief.createCommitment(...args); }

  updateCommitment(...args: Parameters<BeliefService["updateCommitment"]>) { return this.belief.updateCommitment(...args); }

  async setWorldState(input: {
    workerId: WorkerId; key: string; value: unknown; epistemicStatus: EpistemicStatus;
    confidence?: number | undefined; observedAt?: string | undefined; actor?: ActorInput | undefined;
  }): Promise<WorldStateEntry> {
    const key = input.key.trim();
    if (!key) throw new TypeError("World-state key is required");
    if (!["observed", "inferred", "assumed", "unknown"].includes(input.epistemicStatus)) {
      throw new TypeError(`Unknown epistemic status: ${input.epistemicStatus}`);
    }
    const current = this.workers.require(input.workerId);
    const now = new Date().toISOString();
    const entry: WorldStateEntry = {
      key, value: input.value, epistemicStatus: input.epistemicStatus,
      confidence: bounded(input.confidence ?? (input.epistemicStatus === "observed" ? 1 : 0.5), "confidence"),
      provenance: this.makeProvenance(input.actor ?? {}, now),
      observedAt: input.observedAt ?? now, updatedAt: now
    };
    const updated: Worker = {
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

  recordEvidence(...args: Parameters<BeliefService["recordEvidence"]>) { return this.belief.recordEvidence(...args); }

  reviseHypothesesFromEvidence(...args: Parameters<BeliefService["reviseHypothesesFromEvidence"]>) { return this.belief.reviseHypothesesFromEvidence(...args); }

  rankHypotheses(...args: Parameters<BeliefService["rankHypotheses"]>) { return this.belief.rankHypotheses(...args); }

  proposeHypothesis(...args: Parameters<BeliefService["proposeHypothesis"]>) { return this.belief.proposeHypothesis(...args); }
  restateHypothesis(...args: Parameters<BeliefService["restateHypothesis"]>) { return this.belief.restateHypothesis(...args); }
  withdrawEvidence(...args: Parameters<BeliefService["withdrawEvidence"]>) { return this.belief.withdrawEvidence(...args); }

  completeCycle(...args: Parameters<MetacognitionService["completeCycle"]>) { return this.metacognition.completeCycle(...args); }

  recordModelOutcome(...args: Parameters<MetacognitionService["recordModelOutcome"]>) { return this.metacognition.recordModelOutcome(...args); }

  resolveImpasse(...args: Parameters<MetacognitionService["resolveImpasse"]>) { return this.metacognition.resolveImpasse(...args); }

  consultOnImpasse(...args: Parameters<MetacognitionService["consultOnImpasse"]>) { return this.metacognition.consultOnImpasse(...args); }

  recordProcedureDemonstration(...args: Parameters<ProcedureService["recordProcedureDemonstration"]>) { return this.procedures.recordProcedureDemonstration(...args); }

  executeProcedure(...args: Parameters<ProcedureService["executeProcedure"]>) { return this.procedures.executeProcedure(...args); }

  recordKnownAnswer(...args: Parameters<ProcedureService["recordKnownAnswer"]>) { return this.procedures.recordKnownAnswer(...args); }

  retrieveKnownAnswer(...args: Parameters<ProcedureService["retrieveKnownAnswer"]>) { return this.procedures.retrieveKnownAnswer(...args); }

  competeForWorkingMemory(...args: Parameters<WorkspaceService["competeForWorkingMemory"]>) { return this.workspace.competeForWorkingMemory(...args); }

  buildContext(input: {
    workerId: WorkerId;
    expectedOutputContract?: string;
    tokenBudget?: number;
    scope?: "full" | "minimal";
  }): ContextPacket {
    if (!this.config.contextEngine.contextBuilderEnabled) throw new TypeError("Context builder is disabled");
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

  registerModelProcessor(descriptor: ModelProcessorDescriptor, processor: ModelProcessor): void {
    this.modelRegistry.upsert(descriptor, processor);
  }

  async assignModelProcessor(workerId: WorkerId, processorId: string, actor: ActorInput = {}): Promise<Worker> {
    const current = this.workers.require(workerId);
    const processor = this.modelRegistry.select({ id: processorId });
    const now = new Date().toISOString();
    const updated: Worker = {
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

  inferForWorker(...args: Parameters<InferenceService["inferForWorker"]>) { return this.inference.inferForWorker(...args); }

  recordJudgment(...args: Parameters<InferenceService["recordJudgment"]>) { return this.inference.recordJudgment(...args); }

  independentProcessor(...args: Parameters<InferenceService["independentProcessor"]>) { return this.inference.independentProcessor(...args); }

  independentProcessors(...args: Parameters<InferenceService["independentProcessors"]>) { return this.inference.independentProcessors(...args); }

  qualifiedProcessor(...args: Parameters<InferenceService["qualifiedProcessor"]>) { return this.inference.qualifiedProcessor(...args); }

  processorForRole(...args: Parameters<InferenceService["processorForRole"]>) { return this.inference.processorForRole(...args); }

  groundFacts(...args: Parameters<MemoryService["groundFacts"]>) { return this.memory.groundFacts(...args); }

  proposeToolIntent(...args: Parameters<ToolIntentService["proposeToolIntent"]>) { return this.toolIntents.proposeToolIntent(...args); }

  createPrediction(...args: Parameters<PredictionService["createPrediction"]>) { return this.predictions.createPrediction(...args); }

  comparePredictionToObservation(...args: Parameters<PredictionService["comparePredictionToObservation"]>) { return this.predictions.comparePredictionToObservation(...args); }

  executeToolIntent(...args: Parameters<ToolIntentService["executeToolIntent"]>) { return this.toolIntents.executeToolIntent(...args); }

  reinforceMemoryReference(...args: Parameters<MemoryService["reinforceMemoryReference"]>) { return this.memory.reinforceMemoryReference(...args); }

  reinforceAssociation(...args: Parameters<MemoryService["reinforceAssociation"]>) { return this.memory.reinforceAssociation(...args); }

  retrieveMemories(...args: Parameters<MemoryService["retrieveMemories"]>) { return this.memory.retrieveMemories(...args); }

  linkMemoryToDomain(...args: Parameters<MemoryService["linkMemoryToDomain"]>) { return this.memory.linkMemoryToDomain(...args); }

  retrieveDomainMemories(...args: Parameters<MemoryService["retrieveDomainMemories"]>) { return this.memory.retrieveDomainMemories(...args); }

  createParallelPlan(...args: Parameters<CoordinationService["createParallelPlan"]>) { return this.coordination.createParallelPlan(...args); }

  getParallelPlan(...args: Parameters<CoordinationService["getParallelPlan"]>) { return this.coordination.getParallelPlan(...args); }

  sendWorkerMessage(...args: Parameters<CoordinationService["sendWorkerMessage"]>) { return this.coordination.sendWorkerMessage(...args); }

  shareEvidence(...args: Parameters<CoordinationService["shareEvidence"]>) { return this.coordination.shareEvidence(...args); }

  reportSubtask(...args: Parameters<CoordinationService["reportSubtask"]>) { return this.coordination.reportSubtask(...args); }

  aggregateParallelPlan(...args: Parameters<CoordinationService["aggregateParallelPlan"]>) { return this.coordination.aggregateParallelPlan(...args); }

  beginForegroundWork(...args: Parameters<BackgroundCognitionService["beginForegroundWork"]>) { return this.background.beginForegroundWork(...args); }

  runBackgroundCognition(...args: Parameters<BackgroundCognitionService["runBackgroundCognition"]>) { return this.background.runBackgroundCognition(...args); }

  getCognitiveState(workerId: WorkerId) {
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

  getWorker(id: WorkerId): Worker | null { return this.workers.get(id); }
  listWorkers(status?: WorkerStatus): Worker[] { return this.workers.list(status); }
  listEvents(workerId?: WorkerId, afterSequence = 0, limit = 100): CognitiveEvent[] {
    return workerId ? this.events.listForWorker(workerId, afterSequence, limit) : this.events.listAll(afterSequence, limit);
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private async recoverInterruptedWorkers(): Promise<Worker[]> {
    const interrupted = this.workers.list().filter((worker) => INTERRUPTIBLE_STATUSES.includes(worker.status));
    const recovered: Worker[] = [];
    for (const current of interrupted) {
      const now = new Date().toISOString();
      const updated: Worker = {
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

  private makeEvent(...args: Parameters<RuntimeCore["makeEvent"]>) { return this.core.makeEvent(...args); }

  private makeProvenance(...args: Parameters<RuntimeCore["makeProvenance"]>) { return this.core.makeProvenance(...args); }

  private makeMentalObjectRecord(...args: Parameters<RuntimeCore["makeMentalObjectRecord"]>) { return this.core.makeMentalObjectRecord(...args); }

  private requireOwnedObject(...args: Parameters<RuntimeCore["requireOwnedObject"]>) { return this.core.requireOwnedObject(...args); }

  private createAttachedObject(...args: Parameters<RuntimeCore["createAttachedObject"]>) { return this.core.createAttachedObject(...args); }
}
