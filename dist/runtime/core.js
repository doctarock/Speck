// What every runtime service shares: configuration, the database and its
// repositories, the event bus, telemetry, and the construction of the events
// and records that all mutation goes through. SpeckRuntime owns one core and
// hands it to each domain service.
import { randomUUID } from "node:crypto";
import { NotFoundError } from "../errors.js";
import { createCognitiveEventId, createMentalObjectId } from "../types/ids.js";
export class RuntimeCore {
    config;
    database;
    workers;
    mentalObjects;
    events;
    eventBus;
    telemetry;
    constructor(config, database, workers, mentalObjects, events, eventBus, telemetry) {
        this.config = config;
        this.database = database;
        this.workers = workers;
        this.mentalObjects = mentalObjects;
        this.events = events;
        this.eventBus = eventBus;
        this.telemetry = telemetry;
    }
    makeEvent(workerId, type, payload, actor, now) {
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
    makeProvenance(actor, now) {
        return {
            kind: actor.kind ?? "runtime", source: actor.source ?? "speck-runtime",
            actorId: actor.actorId ?? null, eventId: null,
            correlationId: actor.correlationId ?? null, recordedAt: now
        };
    }
    makeMentalObjectRecord(input, now) {
        const content = input.content.trim();
        if (!content)
            throw new TypeError("Mental object content is required");
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
    requireOwnedObject(workerId, objectId) {
        const object = this.mentalObjects.get(objectId);
        if (!object)
            throw new NotFoundError("MentalObject", objectId);
        if (object.workerId !== workerId)
            throw new TypeError("Mental object does not belong to this worker");
        return object;
    }
    async createAttachedObject(input) {
        const current = this.workers.require(input.workerId);
        const now = new Date().toISOString();
        const content = input.content.trim();
        if (!content)
            throw new TypeError("Mental object content is required");
        const object = {
            id: createMentalObjectId(), workerId: input.workerId, kind: input.kind, content,
            data: input.data ?? {}, confidence: bounded(input.confidence ?? 0.5, "confidence"),
            importance: bounded(input.importance ?? 0.5, "importance"),
            memoryRoles: [...new Set(input.memoryRoles)],
            activation: { baseLevel: 0, spreading: 0, noise: 0, suppression: 0, total: 0, decay: this.config.memoryActivation.decayD, references: [now], lastComputedAt: now },
            associations: [],
            workspace: { attentionScore: null, inWorkingMemory: false, broadcastCount: 0, lastBroadcastAt: null },
            provenance: this.makeProvenance(input.actor ?? {}, now), status: "active", createdAt: now, lastAccessedAt: now
        };
        const updated = input.workerField
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
export class RuntimeService {
    core;
    constructor(core) {
        this.core = core;
    }
    get config() { return this.core.config; }
    get database() { return this.core.database; }
    get workers() { return this.core.workers; }
    get mentalObjects() { return this.core.mentalObjects; }
    get events() { return this.core.events; }
    get eventBus() { return this.core.eventBus; }
    get telemetry() { return this.core.telemetry; }
    makeEvent(...args) { return this.core.makeEvent(...args); }
    makeProvenance(...args) { return this.core.makeProvenance(...args); }
    makeMentalObjectRecord(...args) { return this.core.makeMentalObjectRecord(...args); }
    requireOwnedObject(...args) { return this.core.requireOwnedObject(...args); }
    createAttachedObject(...args) { return this.core.createAttachedObject(...args); }
}
export function bounded(value, label) {
    if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new RangeError(`${label} must be between 0 and 1`);
    return value;
}
export function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
//# sourceMappingURL=core.js.map