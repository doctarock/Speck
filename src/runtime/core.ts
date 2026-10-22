// What every runtime service shares: configuration, the database and its
// repositories, the event bus, telemetry, and the construction of the events
// and records that all mutation goes through. SpeckRuntime owns one core and
// hands it to each domain service.

import { randomUUID } from "node:crypto";
import type { SpeckConfig } from "../config.js";
import { NotFoundError } from "../errors.js";
import type { SpeckDatabase } from "../persistence/database.js";
import type { EventRepository } from "../persistence/event-repository.js";
import type { MentalObjectRepository } from "../persistence/mental-object-repository.js";
import type { WorkerRepository } from "../persistence/worker-repository.js";
import { createCognitiveEventId, createMentalObjectId, type MentalObjectId, type WorkerId } from "../types/ids.js";
import type { CognitiveEvent, MentalObject, MentalObjectKind, Provenance, ProvenanceKind, Worker } from "../types/model.js";
import type { EventBus } from "./event-bus.js";
import type { Telemetry } from "./telemetry.js";

export interface ActorInput {
  kind?: ProvenanceKind;
  source?: string;
  actorId?: string | null;
  correlationId?: string | null;
  causationId?: CognitiveEvent["id"] | null;
}

export interface AttachedObjectInput {
  workerId: WorkerId;
  kind: MentalObjectKind;
  content: string;
  data?: Record<string, unknown> | undefined;
  confidence?: number | undefined;
  importance?: number | undefined;
  memoryRoles: MentalObject["memoryRoles"];
  workerField: "commitments" | "hypotheses" | "evidence" | null;
  eventType: CognitiveEvent["type"];
  eventPayload: Record<string, unknown>;
  actor?: ActorInput | undefined;
}

export interface MentalObjectRecordInput {
  workerId: WorkerId | null;
  kind: MentalObjectKind;
  content: string;
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  memoryRoles: MentalObject["memoryRoles"];
  actor: ActorInput;
}

export class RuntimeCore {
  constructor(
    readonly config: SpeckConfig,
    readonly database: SpeckDatabase,
    readonly workers: WorkerRepository,
    readonly mentalObjects: MentalObjectRepository,
    readonly events: EventRepository,
    readonly eventBus: EventBus,
    readonly telemetry: Telemetry
  ) {}

  makeEvent(
    workerId: WorkerId | null, type: CognitiveEvent["type"], payload: Record<string, unknown>,
    actor: ActorInput, now: string
  ) {
    // A worker's event stream is a causal chain by default. Callers can
    // provide an explicit parent for fan-out; root/global events remain roots.
    const previous = workerId ? this.events.latestForWorker(workerId) : null;
    const correlationId = actor.correlationId ?? previous?.correlationId ?? randomUUID();
    const id = createCognitiveEventId();
    return {
      id, workerId, type, payload,
      provenance: { ...this.makeProvenance({ ...actor, correlationId }, now), eventId: id },
      causationId: actor.causationId === null ? null : actor.causationId ?? previous?.id ?? null,
      correlationId, occurredAt: now
    };
  }

  makeProvenance(actor: ActorInput, now: string): Provenance {
    return {
      kind: actor.kind ?? "runtime", source: actor.source ?? "speck-runtime",
      actorId: actor.actorId ?? null, eventId: null,
      correlationId: actor.correlationId ?? null, recordedAt: now
    };
  }

  makeMentalObjectRecord(input: MentalObjectRecordInput, now: string): MentalObject {
    const content = input.content.trim();
    if (!content) throw new TypeError("Mental object content is required");
    return {
      id: createMentalObjectId(), workerId: input.workerId, kind: input.kind,
      content, data: input.data,
      confidence: bounded(input.confidence, "confidence"),
      importance: bounded(input.importance, "importance"),
      memoryRoles: [...new Set(input.memoryRoles)],
      activation: { baseLevel: 0, spreading: 0, noise: 0, suppression: 0, total: 0, decay: this.config.memoryActivation.decayD, references: [now], lastComputedAt: now },
      associations: [],
      workspace: { attentionScore: null, inWorkingMemory: false, broadcastCount: 0, lastBroadcastAt: null },
      provenance: this.makeProvenance(input.actor, now),
      status: "active", createdAt: now, lastAccessedAt: now
    };
  }

  requireOwnedObject(workerId: WorkerId, objectId: MentalObjectId): MentalObject {
    const object = this.mentalObjects.get(objectId);
    if (!object) throw new NotFoundError("MentalObject", objectId);
    if (object.workerId !== workerId) throw new TypeError("Mental object does not belong to this worker");
    return object;
  }

  async createAttachedObject(input: AttachedObjectInput): Promise<MentalObject> {
    const current = this.workers.require(input.workerId);
    const now = new Date().toISOString();
    const content = input.content.trim();
    if (!content) throw new TypeError("Mental object content is required");
    const object: MentalObject = {
      id: createMentalObjectId(), workerId: input.workerId, kind: input.kind, content,
      data: input.data ?? {}, confidence: bounded(input.confidence ?? 0.5, "confidence"),
      importance: bounded(input.importance ?? 0.5, "importance"),
      memoryRoles: [...new Set(input.memoryRoles)],
      activation: { baseLevel: 0, spreading: 0, noise: 0, suppression: 0, total: 0, decay: this.config.memoryActivation.decayD, references: [now], lastComputedAt: now },
      associations: [],
      workspace: { attentionScore: null, inWorkingMemory: false, broadcastCount: 0, lastBroadcastAt: null },
      provenance: this.makeProvenance(input.actor ?? {}, now), status: "active", createdAt: now, lastAccessedAt: now
    };
    const updated: Worker = input.workerField
      ? { ...current, [input.workerField]: [...current[input.workerField], object.id], updatedAt: now, revision: current.revision + 1 }
      : { ...current, updatedAt: now, revision: current.revision + 1 };
    const event = this.makeEvent(input.workerId, input.eventType, { objectId: object.id, ...input.eventPayload }, input.actor ?? {}, now);
    const persistedEvent = this.database.transaction(() => {
      this.mentalObjects.insert(object);
      this.workers.update(updated, current.revision);
      return this.eventBus.persist(event);
    });
    await this.eventBus.dispatch(persistedEvent);
    this.telemetry.increment(`mental_objects.${input.kind}.created`);
    return object;
  }
}

// A domain service: the core under the names the runtime's code uses.
export abstract class RuntimeService {
  constructor(protected readonly core: RuntimeCore) {}
  protected get config() { return this.core.config; }
  protected get database() { return this.core.database; }
  protected get workers() { return this.core.workers; }
  protected get mentalObjects() { return this.core.mentalObjects; }
  protected get events() { return this.core.events; }
  protected get eventBus() { return this.core.eventBus; }
  protected get telemetry() { return this.core.telemetry; }
  protected makeEvent(...args: Parameters<RuntimeCore["makeEvent"]>) { return this.core.makeEvent(...args); }
  protected makeProvenance(...args: Parameters<RuntimeCore["makeProvenance"]>) { return this.core.makeProvenance(...args); }
  protected makeMentalObjectRecord(...args: Parameters<RuntimeCore["makeMentalObjectRecord"]>) { return this.core.makeMentalObjectRecord(...args); }
  protected requireOwnedObject(...args: Parameters<RuntimeCore["requireOwnedObject"]>) { return this.core.requireOwnedObject(...args); }
  protected createAttachedObject(...args: Parameters<RuntimeCore["createAttachedObject"]>) { return this.core.createAttachedObject(...args); }
}

export function bounded(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be between 0 and 1`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
