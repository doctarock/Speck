// Working memory: admission, and the competition among candidates for the
// limited workspace (coalitions, crowding, hysteresis, broadcast).
import { applyCrowdingNormalization, broadcast, decideAdmissionWithHysteresis, formCoalition, rankCandidates } from "../../context/competition.js";
import { NotFoundError } from "../../errors.js";
import { recordReference } from "../../memory/activation.js";
import { ActivationGraph } from "../../memory/graph.js";
import { predictionSignals } from "./predictions.js";
import { RuntimeService } from "../core.js";
export class WorkspaceService extends RuntimeService {
    runtime;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async admitToWorkingMemory(workerId, objectId, actor = {}) {
        const current = this.workers.require(workerId);
        const object = this.mentalObjects.get(objectId);
        if (!object)
            throw new NotFoundError("MentalObject", objectId);
        if (object.workerId !== workerId)
            throw new TypeError("Mental object does not belong to this worker");
        if (current.workingMemory.includes(objectId))
            return current;
        const nextIds = [...current.workingMemory, objectId];
        const evictedId = nextIds.length > this.config.workingMemoryCapacity ? nextIds.shift() ?? null : null;
        const now = new Date().toISOString();
        const updated = { ...current, workingMemory: nextIds, updatedAt: now, revision: current.revision + 1 };
        const admitted = {
            ...object,
            memoryRoles: [...new Set([...object.memoryRoles, "working"])],
            workspace: {
                attentionScore: object.workspace.attentionScore ?? object.activation.total,
                inWorkingMemory: true,
                broadcastCount: object.workspace.broadcastCount + 1,
                lastBroadcastAt: now
            },
            activation: this.config.memoryActivation.referenceReinforcementEnabled
                ? recordReference(object.activation, new Date(now), this.config.memoryActivation.referenceLogCapacity)
                : object.activation,
            lastAccessedAt: now
        };
        const evicted = evictedId ? this.mentalObjects.get(evictedId) : null;
        const updatedEvicted = evicted ? {
            ...evicted,
            memoryRoles: evicted.memoryRoles.filter((role) => role !== "working"),
            workspace: { ...evicted.workspace, inWorkingMemory: false },
            lastAccessedAt: now
        } : null;
        const event = this.makeEvent(workerId, "working-memory.admitted", { objectId, evictedId }, actor, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(admitted);
            if (updatedEvicted)
                this.mentalObjects.update(updatedEvicted);
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("working_memory.admissions");
        if (evictedId)
            this.telemetry.increment("working_memory.evictions");
        return updated;
    }
    async competeForWorkingMemory(input) {
        const current = this.workers.require(input.workerId);
        const objects = this.mentalObjects.listForWorker(input.workerId);
        const graph = new ActivationGraph(objects);
        const requested = new Set([...(input.candidateIds ?? objects.map((object) => object.id)), ...current.workingMemory]);
        for (const id of requested)
            this.requireOwnedObject(input.workerId, id);
        const eligibleObjects = objects.filter((object) => requested.has(object.id)
            && (object.status === "active" || object.status === "dormant")
            && !(object.data.domainAnchor && typeof object.data.domainAnchor === "object"));
        const signalMap = new Map();
        for (const object of eligibleObjects) {
            signalMap.set(object.id, { ...predictionSignals(object), ...(input.signals?.[object.id] ?? {}) });
        }
        const config = this.config.contextEngine;
        const formed = formCoalition(eligibleObjects, signalMap, config);
        const candidates = config.crowdingEnabled
            ? applyCrowdingNormalization(formed, config.crowdingStrength)
            : formed;
        const admitted = config.hysteresisEnabled
            ? decideAdmissionWithHysteresis(candidates, new Set(current.workingMemory), this.config.workingMemoryCapacity, config.ignitionThreshold)
            : rankCandidates(candidates).slice(0, this.config.workingMemoryCapacity);
        const now = input.at ?? new Date();
        const learnedConfig = {
            ...config,
            coalescenceLearningEnabled: config.coalescenceLearningEnabled && this.config.memoryActivation.associativeEdgesEnabled,
            lateralInhibitionLearningEnabled: config.lateralInhibitionLearningEnabled
                && this.config.memoryActivation.associativeEdgesEnabled
                && this.config.memoryActivation.inhibitionEnabled
        };
        const result = broadcast(graph, candidates, admitted, new Set(current.workingMemory), now, learnedConfig, this.config.memoryActivation.hebbianIncrement, this.config.memoryActivation.maxEdgeStrength);
        const updated = {
            ...current,
            workingMemory: result.workingMemory,
            updatedAt: now.toISOString(),
            revision: current.revision + 1
        };
        const event = this.makeEvent(input.workerId, "working-memory.competed", {
            candidateIds: candidates.map((candidate) => candidate.id),
            admittedIds: result.workingMemory,
            newlyAdmittedIds: result.newlyAdmitted,
            releasedIds: result.released
        }, input.actor ?? {}, now.toISOString());
        const persistedEvent = this.database.transaction(() => {
            for (const object of graph.values())
                this.mentalObjects.update(object);
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("working_memory.competitions");
        this.telemetry.increment("working_memory.ignitions", result.newlyAdmitted.length);
        this.telemetry.increment("working_memory.releases", result.released.length);
        return { worker: updated, candidates: rankCandidates(candidates), newlyAdmitted: result.newlyAdmitted, released: result.released };
    }
}
//# sourceMappingURL=workspace.js.map