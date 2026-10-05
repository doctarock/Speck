// Belief: evidence, hypotheses revised by it, and commitments.
import { NotFoundError } from "../../errors.js";
import { rankHypotheses, reviseHypothesis } from "../../belief/revision.js";
import { bounded, RuntimeService } from "../core.js";
export class BeliefService extends RuntimeService {
    runtime;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async recordEvidence(input) {
        const source = input.source.trim();
        if (!source)
            throw new TypeError("Evidence source is required");
        const current = this.workers.require(input.workerId);
        const actor = input.actor ?? {};
        const claimedReliability = bounded(input.reliability ?? 0.5, "reliability");
        const reliability = actor.kind === "model"
            ? Math.min(claimedReliability, this.config.beliefRevision.modelReliabilityCeiling)
            : claimedReliability;
        const relations = normalizeEvidenceRelations(input.supports, input.contradicts, input.relations);
        this.validateEvidenceRelations(input.workerId, relations);
        const now = new Date().toISOString();
        let evidence = this.makeMentalObjectRecord({
            workerId: input.workerId,
            kind: "evidence",
            content: input.content,
            data: {
                source, reliability, claimedReliability,
                sourceKind: actor.kind ?? "runtime", supports: [], contradicts: []
            },
            confidence: 0.5,
            importance: 0.5,
            memoryRoles: ["evidence"],
            actor
        }, now);
        const applied = this.applyEvidenceRelations(evidence, relations, reliability, source, now);
        evidence = applied.evidence;
        const updatedWorker = this.workerAfterBeliefRevision(current, applied.hypotheses, evidence.id, true, now);
        const evidenceEvent = this.makeEvent(input.workerId, "evidence.recorded", {
            objectId: evidence.id, source, reliability, relationCount: applied.revisions.length
        }, actor, now);
        const revisionEvents = applied.revisions.map((revision) => this.makeEvent(input.workerId, "belief.revised", {
            hypothesisId: revision.hypothesisId,
            evidenceId: evidence.id,
            direction: revision.entry.direction,
            previousConfidence: revision.entry.previousConfidence,
            newConfidence: revision.entry.newConfidence,
            previousStatus: revision.entry.previousStatus,
            newStatus: revision.entry.newStatus
        }, actor, now));
        const persisted = this.database.transaction(() => {
            this.mentalObjects.insert(evidence);
            for (const hypothesis of applied.hypotheses)
                this.mentalObjects.update(hypothesis);
            this.workers.update(updatedWorker, current.revision);
            return [evidenceEvent, ...revisionEvents].map((event) => this.eventBus.persist(event));
        });
        for (const event of persisted)
            await this.eventBus.dispatch(event);
        this.telemetry.increment("mental_objects.evidence.created");
        this.telemetry.increment("belief.revisions", applied.revisions.length);
        return evidence;
    }
    async reviseHypothesesFromEvidence(input) {
        const current = this.workers.require(input.workerId);
        const currentEvidence = this.requireOwnedObject(input.workerId, input.evidenceId);
        if (currentEvidence.kind !== "evidence" || !current.evidence.includes(currentEvidence.id)) {
            throw new TypeError("Evidence does not belong to this worker's evidence ledger");
        }
        const relations = normalizeEvidenceRelations(undefined, undefined, input.relations);
        this.validateEvidenceRelations(input.workerId, relations);
        const existingSupports = new Set(arrayIds(currentEvidence.data.supports));
        const existingContradicts = new Set(arrayIds(currentEvidence.data.contradicts));
        for (const relation of relations) {
            if (relation.direction === "supports" && existingContradicts.has(relation.hypothesisId)
                || relation.direction === "contradicts" && existingSupports.has(relation.hypothesisId)) {
                throw new TypeError("Evidence cannot both support and contradict the same hypothesis");
            }
        }
        const fresh = relations.filter((relation) => relation.direction === "supports"
            ? !existingSupports.has(relation.hypothesisId) : !existingContradicts.has(relation.hypothesisId));
        if (!fresh.length) {
            return { evidence: currentEvidence, hypotheses: this.rankHypotheses(input.workerId), revisions: [], worker: current };
        }
        const reliability = bounded(Number(currentEvidence.data.reliability ?? 0.5), "reliability");
        const source = String(currentEvidence.data.source ?? currentEvidence.provenance.source);
        const now = new Date().toISOString();
        const applied = this.applyEvidenceRelations(currentEvidence, fresh, reliability, source, now);
        const updatedWorker = this.workerAfterBeliefRevision(current, applied.hypotheses, currentEvidence.id, false, now);
        const actor = input.actor ?? {};
        const events = applied.revisions.map((revision) => this.makeEvent(input.workerId, "belief.revised", {
            hypothesisId: revision.hypothesisId, evidenceId: currentEvidence.id,
            direction: revision.entry.direction,
            previousConfidence: revision.entry.previousConfidence,
            newConfidence: revision.entry.newConfidence,
            previousStatus: revision.entry.previousStatus,
            newStatus: revision.entry.newStatus
        }, actor, now));
        const persisted = this.database.transaction(() => {
            this.mentalObjects.update(applied.evidence);
            for (const hypothesis of applied.hypotheses)
                this.mentalObjects.update(hypothesis);
            this.workers.update(updatedWorker, current.revision);
            return events.map((event) => this.eventBus.persist(event));
        });
        for (const event of persisted)
            await this.eventBus.dispatch(event);
        this.telemetry.increment("belief.revisions", applied.revisions.length);
        return {
            evidence: applied.evidence,
            hypotheses: this.rankHypotheses(input.workerId),
            revisions: applied.revisions.map((revision) => revision.entry),
            worker: updatedWorker
        };
    }
    rankHypotheses(workerId) {
        const worker = this.workers.require(workerId);
        const byId = new Map(this.mentalObjects.listForWorker(workerId).map((object) => [object.id, object]));
        return rankHypotheses(worker.hypotheses.map((id) => byId.get(id)).filter((object) => Boolean(object)));
    }
    async proposeHypothesis(input) {
        const confidence = bounded(input.confidence ?? 0.5, "confidence");
        const now = new Date().toISOString();
        return this.createAttachedObject({
            workerId: input.workerId, kind: "hypothesis", content: input.content, confidence,
            data: { ...(input.data ?? {}), status: "proposed", supportingEvidence: [], contradictoryEvidence: [], revisionHistory: [], lastUpdatedAt: now },
            memoryRoles: [], workerField: "hypotheses", eventType: "hypothesis.proposed",
            eventPayload: { confidence }, actor: input.actor
        });
    }
    // A hypothesis stated more fully as evidence fills it in (for example a
    // rule's mapping once a new value has been seen). The hypothesis is the same;
    // its belief state is untouched, and the event keeps the earlier statement.
    async restateHypothesis(input) {
        const hypothesis = this.requireOwnedObject(input.workerId, input.hypothesisId);
        if (hypothesis.kind !== "hypothesis")
            throw new TypeError("Only a hypothesis can be restated");
        const content = input.content.trim();
        if (!content)
            throw new TypeError("Hypothesis content is required");
        if (content === hypothesis.content)
            return hypothesis;
        const now = new Date().toISOString();
        const updated = { ...hypothesis, content, lastAccessedAt: now };
        const event = this.makeEvent(input.workerId, "hypothesis.restated", { objectId: hypothesis.id, previous: hypothesis.content, content }, input.actor ?? {}, now);
        const persisted = this.database.transaction(() => {
            this.mentalObjects.update(updated);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
        return updated;
    }
    // Evidence that does not belong to the task after all (the user moved the
    // message to another episode) is withdrawn: archived, and no longer one of
    // the task's evidence. Belief revisions it already caused are not undone.
    async withdrawEvidence(input) {
        const current = this.workers.require(input.workerId);
        const evidence = this.requireOwnedObject(input.workerId, input.evidenceId);
        if (evidence.kind !== "evidence")
            throw new TypeError("Only evidence can be withdrawn");
        if (evidence.status === "archived")
            return;
        const now = new Date().toISOString();
        const updated = { ...evidence, status: "archived", lastAccessedAt: now, data: { ...evidence.data, withdrawn: { reason: input.reason, at: now } } };
        const worker = { ...current, evidence: current.evidence.filter((id) => id !== evidence.id), updatedAt: now, revision: current.revision + 1 };
        const event = this.makeEvent(input.workerId, "evidence.withdrawn", { objectId: evidence.id, reason: input.reason }, input.actor ?? {}, now);
        const persisted = this.database.transaction(() => {
            this.mentalObjects.update(updated);
            this.workers.update(worker, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
    }
    validateEvidenceRelations(workerId, relations) {
        for (const relation of relations) {
            const referenced = this.mentalObjects.get(relation.hypothesisId);
            if (!referenced)
                throw new NotFoundError("MentalObject", relation.hypothesisId);
            if (referenced.workerId !== workerId || referenced.kind !== "hypothesis") {
                throw new TypeError("Evidence may only reference hypotheses owned by the same worker");
            }
            bounded(relation.strength ?? 1, "evidence relation strength");
        }
    }
    applyEvidenceRelations(sourceEvidence, relations, reliability, source, now) {
        let evidence = { ...sourceEvidence, data: { ...sourceEvidence.data }, associations: [...sourceEvidence.associations], lastAccessedAt: now };
        const supports = arrayIds(evidence.data.supports);
        const contradicts = arrayIds(evidence.data.contradicts);
        const hypotheses = [];
        const revisions = [];
        for (const relation of relations) {
            const current = this.requireOwnedObject(sourceEvidence.workerId, relation.hypothesisId);
            const revised = reviseHypothesis({
                hypothesis: current,
                evidenceId: sourceEvidence.id,
                relation,
                reliability,
                source,
                at: now,
                config: this.config.beliefRevision
            });
            if (revised.revision) {
                hypotheses.push(revised.hypothesis);
                revisions.push({ hypothesisId: relation.hypothesisId, entry: revised.revision });
            }
            const target = relation.direction === "supports" ? supports : contradicts;
            if (!target.includes(relation.hypothesisId))
                target.push(relation.hypothesisId);
            if (!evidence.associations.some((edge) => edge.targetId === relation.hypothesisId && edge.kind === relation.direction)) {
                evidence.associations.push({
                    targetId: relation.hypothesisId,
                    kind: relation.direction,
                    strength: bounded(reliability * (relation.strength ?? 1), "evidence edge strength"),
                    lastCoactivatedAt: now
                });
            }
        }
        evidence = { ...evidence, data: { ...evidence.data, supports, contradicts } };
        return { evidence, hypotheses, revisions };
    }
    workerAfterBeliefRevision(current, updatedHypotheses, evidenceId, appendEvidence, now) {
        const replacements = new Map(updatedHypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
        const existing = new Map(this.mentalObjects.listForWorker(current.id).map((object) => [object.id, object]));
        const ranked = rankHypotheses(current.hypotheses.map((id) => replacements.get(id) ?? existing.get(id))
            .filter((object) => Boolean(object)));
        const hypothesisIds = new Set(current.hypotheses);
        const nonHypothesisBeliefs = current.beliefs.filter((id) => !hypothesisIds.has(id));
        const confirmed = ranked.filter((hypothesis) => hypothesis.data.status === "confirmed").map((hypothesis) => hypothesis.id);
        return {
            ...current,
            hypotheses: ranked.map((hypothesis) => hypothesis.id),
            beliefs: [...nonHypothesisBeliefs, ...confirmed],
            evidence: appendEvidence ? [...current.evidence, evidenceId] : current.evidence,
            updatedAt: now,
            revision: current.revision + 1
        };
    }
    async createCommitment(input) {
        const priority = input.priority ?? "medium";
        if (!["low", "medium", "high"].includes(priority))
            throw new TypeError(`Unknown commitment priority: ${priority}`);
        return this.createAttachedObject({
            workerId: input.workerId, kind: "commitment", content: input.content,
            data: { priority, status: "active" }, memoryRoles: [], workerField: "commitments",
            eventType: "commitment.created", eventPayload: { priority }, actor: input.actor
        });
    }
    async updateCommitment(workerId, commitmentId, status, actor = {}) {
        if (!["completed", "invalidated", "superseded", "deferred"].includes(status)) {
            throw new TypeError(`Unknown commitment status: ${String(status)}`);
        }
        const worker = this.workers.require(workerId);
        const current = this.mentalObjects.get(commitmentId);
        if (!current)
            throw new NotFoundError("MentalObject", commitmentId);
        if (current.workerId !== workerId || current.kind !== "commitment" || !worker.commitments.includes(commitmentId)) {
            throw new TypeError("Commitment does not belong to this worker");
        }
        const now = new Date().toISOString();
        const updatedObject = {
            ...current,
            data: { ...current.data, status },
            status: status === "superseded" ? "superseded" : current.status,
            lastAccessedAt: now
        };
        const updatedWorker = { ...worker, updatedAt: now, revision: worker.revision + 1 };
        const event = this.makeEvent(workerId, "commitment-changed", { commitmentId, status }, actor, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(updatedObject);
            this.workers.update(updatedWorker, worker.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        return updatedObject;
    }
}
function normalizeEvidenceRelations(supports, contradicts, relations) {
    const combined = [
        ...(supports ?? []).map((hypothesisId) => ({ hypothesisId, direction: "supports", strength: 1 })),
        ...(contradicts ?? []).map((hypothesisId) => ({ hypothesisId, direction: "contradicts", strength: 1 })),
        ...(relations ?? []).map((relation) => ({ ...relation, strength: relation.strength ?? 1 }))
    ];
    const byHypothesis = new Map();
    for (const relation of combined) {
        const previous = byHypothesis.get(relation.hypothesisId);
        if (previous && previous.direction !== relation.direction) {
            throw new TypeError("Evidence cannot both support and contradict the same hypothesis");
        }
        if (!previous || (relation.strength ?? 1) > (previous.strength ?? 1))
            byHypothesis.set(relation.hypothesisId, relation);
    }
    return [...byHypothesis.values()];
}
function arrayIds(value) {
    return Array.isArray(value) ? value.map(String) : [];
}
//# sourceMappingURL=belief.js.map