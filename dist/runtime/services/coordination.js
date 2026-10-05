// Parallel coordination: plans of subtask workers, messages and shared
// evidence between them, subtask reports, and aggregation.
import { NotFoundError } from "../../errors.js";
import { emptyMetacognitiveState } from "../../metacognition/assessment.js";
import { dependenciesSatisfied, readParallelPlan, validateSubtasks } from "../../coordination/planner.js";
import { WORKER_MESSAGE_TYPES } from "../../coordination/types.js";
import { createMentalObjectId, createWorkerId } from "../../types/ids.js";
import { RuntimeService } from "../core.js";
export class CoordinationService extends RuntimeService {
    runtime;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async createParallelPlan(input) {
        if (!this.config.coordination.enabled)
            throw new TypeError("Parallel worker coordination is disabled");
        const planner = this.workers.require(input.plannerWorkerId);
        const specs = validateSubtasks(input.subtasks, this.config.coordination.maximumSubtasks);
        const now = new Date().toISOString();
        const planId = createMentalObjectId();
        const rootWorkerId = planner.coordination?.rootWorkerId ?? planner.id;
        const workers = specs.map((spec) => this.makeSubtaskWorker(spec, planner, rootWorkerId, planId, now));
        const definition = {
            schema: "speck.parallel-plan.v1",
            plannerWorkerId: planner.id,
            objective: String(input.objective ?? planner.objective.description).trim() || planner.objective.description,
            status: "active",
            subtasks: specs.map((spec, index) => ({
                ...spec,
                workerId: workers[index].id,
                status: spec.dependencies.length === 0 ? "ready" : "blocked",
                summary: null,
                evidenceIds: [],
                completedAt: null
            })),
            createdAt: now,
            completedAt: null
        };
        const plan = this.makeMentalObjectRecord({
            workerId: planner.id, kind: "artifact", content: `Parallel plan: ${definition.objective}`,
            data: definition, confidence: 1, importance: 1,
            memoryRoles: ["semantic"], actor: input.actor ?? {}
        }, now);
        // The id is allocated before child Workers so every assignment can durably
        // point at the exact plan without sharing any mutable object.
        const persistedPlan = { ...plan, id: planId };
        const events = [
            this.makeEvent(planner.id, "plan.created", { planId, objective: definition.objective, subtaskCount: specs.length }, input.actor ?? {}, now),
            ...workers.map((worker, index) => this.makeEvent(worker.id, "subtask.assigned", {
                planId, plannerWorkerId: planner.id, subtaskId: specs[index].id,
                dependencies: specs[index].dependencies, status: definition.subtasks[index].status
            }, { kind: "worker", source: planner.id, actorId: planner.id }, now))
        ];
        const persistedEvents = this.database.transaction(() => {
            this.mentalObjects.insert(persistedPlan);
            for (const worker of workers)
                this.workers.insert(worker);
            return events.map((event) => this.eventBus.persist(event));
        });
        for (const event of persistedEvents)
            await this.eventBus.dispatch(event);
        this.telemetry.increment("plans.created");
        this.telemetry.increment("subtasks.assigned", workers.length);
        this.telemetry.gauge("workers.total", this.workers.list().length);
        return { plan: persistedPlan, workers };
    }
    getParallelPlan(plannerWorkerId, planId) {
        this.workers.require(plannerWorkerId);
        const object = this.requireOwnedObject(plannerWorkerId, planId);
        const plan = readParallelPlan(object);
        if (!plan)
            throw new TypeError("Mental object is not a parallel plan");
        return { object, plan };
    }
    async sendWorkerMessage(input) {
        if (!WORKER_MESSAGE_TYPES.includes(input.type))
            throw new TypeError(`Unknown worker message type: ${String(input.type)}`);
        const sender = this.workers.require(input.senderWorkerId);
        const recipient = this.workers.require(input.recipientWorkerId);
        const { plan } = this.requireSharedPlan(sender, recipient, input.planId);
        if (input.subtaskId && !plan.subtasks.some((entry) => entry.id === input.subtaskId))
            throw new TypeError(`Unknown subtask ${input.subtaskId}`);
        const now = new Date().toISOString();
        const message = {
            schema: "speck.worker-message.v1", type: input.type,
            senderWorkerId: sender.id, recipientWorkerId: recipient.id, planId: input.planId,
            subtaskId: input.subtaskId ?? null, payload: input.payload ?? {}, sentAt: now
        };
        const object = this.makeMentalObjectRecord({
            workerId: recipient.id, kind: "observation", content: `${input.type} from ${sender.id}`,
            data: message, confidence: 1, importance: 0.8,
            memoryRoles: ["episodic"], actor: { kind: "worker", source: sender.id, actorId: sender.id, correlationId: input.actor?.correlationId ?? null }
        }, now);
        const event = this.makeEvent(recipient.id, "worker.message-sent", {
            messageId: object.id, type: input.type, senderWorkerId: sender.id, recipientWorkerId: recipient.id,
            planId: input.planId, subtaskId: message.subtaskId
        }, { kind: "worker", source: sender.id, actorId: sender.id, correlationId: input.actor?.correlationId ?? null }, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.insert(object);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("worker_messages.sent");
        return object;
    }
    async shareEvidence(input) {
        const sourceWorker = this.workers.require(input.sourceWorkerId);
        const targetWorker = this.workers.require(input.targetWorkerId);
        this.requireSharedPlan(sourceWorker, targetWorker, input.planId);
        const source = this.requireOwnedObject(sourceWorker.id, input.evidenceId);
        if (source.kind !== "evidence")
            throw new TypeError("Only first-class Evidence may be shared between Workers");
        const now = new Date().toISOString();
        const copy = this.makeMentalObjectRecord({
            workerId: targetWorker.id, kind: "evidence", content: source.content,
            data: {
                ...source.data, sharedEvidence: true, sourceEvidenceId: source.id,
                sourceWorkerId: sourceWorker.id, planId: input.planId
            },
            confidence: source.confidence, importance: source.importance, memoryRoles: ["evidence"],
            actor: { kind: "worker", source: sourceWorker.id, actorId: sourceWorker.id, correlationId: input.actor?.correlationId ?? null }
        }, now);
        const current = this.workers.require(targetWorker.id);
        const updated = { ...current, evidence: [...current.evidence, copy.id], updatedAt: now, revision: current.revision + 1 };
        const event = this.makeEvent(targetWorker.id, "evidence.shared", {
            sourceWorkerId: sourceWorker.id, targetWorkerId: targetWorker.id,
            sourceEvidenceId: source.id, evidenceId: copy.id, planId: input.planId
        }, { kind: "worker", source: sourceWorker.id, actorId: sourceWorker.id, correlationId: input.actor?.correlationId ?? null }, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.insert(copy);
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("evidence.shared");
        return copy;
    }
    async reportSubtask(input) {
        if (!["completed", "failed", "impasse"].includes(input.status)) {
            throw new TypeError(`Unknown subtask report status: ${String(input.status)}`);
        }
        const worker = this.workers.require(input.workerId);
        const coordination = worker.coordination;
        if (!coordination || coordination.planId !== input.planId || coordination.subtaskId !== input.subtaskId) {
            throw new TypeError("Worker is not assigned to that plan subtask");
        }
        const { object: planObject, plan } = this.getParallelPlan(coordination.plannerWorkerId, input.planId);
        if (plan.status !== "active")
            throw new TypeError("Parallel plan is not active");
        const task = plan.subtasks.find((entry) => entry.id === input.subtaskId);
        if (!task || task.workerId !== worker.id)
            throw new TypeError("Subtask assignment does not match Worker");
        if (task.status === "completed" || task.status === "failed" || task.status === "impasse")
            throw new TypeError("Subtask already has a terminal report");
        if (!dependenciesSatisfied(plan, task.id))
            throw new TypeError("Subtask dependencies are not complete");
        const summary = input.summary.trim();
        if (!summary)
            throw new TypeError("Subtask report summary is required");
        const sourceEvidence = [...new Set(input.evidenceIds ?? [])].map((id) => {
            const evidence = this.requireOwnedObject(worker.id, id);
            if (evidence.kind !== "evidence")
                throw new TypeError("Subtask reports may only attach first-class Evidence");
            return evidence;
        });
        const now = new Date().toISOString();
        const planner = this.workers.require(plan.plannerWorkerId);
        const copies = sourceEvidence.map((source) => this.makeMentalObjectRecord({
            workerId: planner.id, kind: "evidence", content: source.content,
            data: { ...source.data, sharedEvidence: true, sourceEvidenceId: source.id, sourceWorkerId: worker.id, planId: input.planId, subtaskId: task.id },
            confidence: source.confidence, importance: source.importance, memoryRoles: ["evidence"],
            actor: { kind: "worker", source: worker.id, actorId: worker.id }
        }, now));
        task.status = input.status;
        task.summary = summary;
        task.evidenceIds = copies.map((copy) => copy.id);
        task.completedAt = now;
        const unblocked = plan.subtasks.filter((candidate) => candidate.status === "blocked" && dependenciesSatisfied(plan, candidate.id));
        for (const candidate of unblocked)
            candidate.status = "ready";
        const cascadedWorkerIds = input.status === "completed" ? [] : this.cascadeBlockedFailures(plan, task.id, now);
        const updatedPlan = { ...planObject, data: plan, lastAccessedAt: now };
        const updatedPlanner = copies.length === 0 ? planner : {
            ...planner, evidence: [...planner.evidence, ...copies.map((copy) => copy.id)], updatedAt: now, revision: planner.revision + 1
        };
        const updatedReporter = {
            ...worker, status: input.status === "completed" ? "completed" : input.status,
            updatedAt: now, revision: worker.revision + 1
        };
        const unblockedWorkers = unblocked.map((candidate) => this.workers.require(candidate.workerId));
        const cascadedWorkers = cascadedWorkerIds.map((id) => this.workers.require(id));
        const events = [
            this.makeEvent(worker.id, "subtask.reported", { planId: input.planId, subtaskId: task.id, status: input.status, summary, sharedEvidenceIds: copies.map((copy) => copy.id) }, input.actor ?? { kind: "worker", source: worker.id, actorId: worker.id }, now),
            ...copies.map((copy, index) => this.makeEvent(planner.id, "evidence.shared", { planId: input.planId, subtaskId: task.id, sourceWorkerId: worker.id, sourceEvidenceId: sourceEvidence[index].id, evidenceId: copy.id }, { kind: "worker", source: worker.id, actorId: worker.id }, now)),
            ...unblocked.map((candidate) => this.makeEvent(candidate.workerId, "dependency.resolved", { planId: input.planId, subtaskId: candidate.id, dependencies: candidate.dependencies }, { kind: "worker", source: planner.id, actorId: planner.id }, now)),
            ...plan.subtasks.filter((candidate) => cascadedWorkerIds.includes(candidate.workerId)).map((candidate) => this.makeEvent(candidate.workerId, "subtask.reported", {
                planId: input.planId, subtaskId: candidate.id, status: "failed", summary: candidate.summary, automatic: true
            }, { kind: "worker", source: planner.id, actorId: planner.id }, now))
        ];
        const persistedEvents = this.database.transaction(() => {
            for (const copy of copies)
                this.mentalObjects.insert(copy);
            this.mentalObjects.update(updatedPlan);
            this.workers.update(updatedReporter, worker.revision);
            if (copies.length > 0)
                this.workers.update(updatedPlanner, planner.revision);
            for (const current of unblockedWorkers) {
                this.workers.update({ ...current, status: "ready", updatedAt: now, revision: current.revision + 1 }, current.revision);
            }
            for (const current of cascadedWorkers) {
                this.workers.update({ ...current, status: "failed", updatedAt: now, revision: current.revision + 1 }, current.revision);
            }
            return events.map((event) => this.eventBus.persist(event));
        });
        for (const event of persistedEvents)
            await this.eventBus.dispatch(event);
        this.telemetry.increment("subtasks.reported");
        this.telemetry.increment("dependencies.resolved", unblocked.length);
        return { plan: updatedPlan, sharedEvidence: copies, unblockedWorkerIds: unblocked.map((entry) => entry.workerId) };
    }
    async aggregateParallelPlan(input) {
        const { object, plan } = this.getParallelPlan(input.plannerWorkerId, input.planId);
        if (plan.status !== "active")
            throw new TypeError("Parallel plan has already been aggregated");
        const terminal = new Set(["completed", "failed", "impasse"]);
        if (plan.subtasks.some((entry) => !terminal.has(entry.status)))
            throw new TypeError("Cannot aggregate a plan with unresolved subtasks");
        const successful = plan.subtasks.every((entry) => entry.status === "completed");
        const result = {
            planId: input.planId, objective: plan.objective, successful,
            summary: plan.subtasks.map((entry) => `[${entry.id}:${entry.status}] ${entry.summary ?? "No report"}`).join("\n"),
            subtaskResults: plan.subtasks.map((entry) => ({
                subtaskId: entry.id, workerId: entry.workerId, status: entry.status,
                summary: entry.summary, evidenceIds: [...entry.evidenceIds]
            })),
            evidenceIds: [...new Set(plan.subtasks.flatMap((entry) => entry.evidenceIds))]
        };
        const now = new Date().toISOString();
        plan.status = successful ? "completed" : "failed";
        plan.completedAt = now;
        const updatedPlan = { ...object, data: plan, lastAccessedAt: now };
        const artifact = this.makeMentalObjectRecord({
            workerId: input.plannerWorkerId, kind: "artifact", content: result.summary,
            data: { schema: "speck.parallel-result.v1", ...result }, confidence: successful ? 1 : 0.5,
            importance: 1, memoryRoles: ["episodic", "semantic"], actor: input.actor ?? {}
        }, now);
        const event = this.makeEvent(input.plannerWorkerId, "plan.aggregated", {
            planId: input.planId, resultId: artifact.id, successful, evidenceIds: result.evidenceIds
        }, input.actor ?? {}, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(updatedPlan);
            this.mentalObjects.insert(artifact);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("plans.aggregated");
        return { result, artifact, plan: updatedPlan };
    }
    makeSubtaskWorker(spec, planner, rootWorkerId, planId, now) {
        return {
            id: createWorkerId(),
            objective: {
                description: spec.objective,
                constraints: [...planner.objective.constraints, ...spec.constraints]
            },
            status: spec.dependencies.length === 0 ? "ready" : "waiting",
            workingMemory: [], commitments: [], beliefs: [], hypotheses: [], evidence: [],
            worldState: {}, currentStrategy: null, currentProcedure: null,
            modelAssignment: planner.modelAssignment ? { ...planner.modelAssignment } : null,
            progress: { cycle: 0, lastProgressAt: null, score: 0 },
            confidence: { overall: 0.5, calibrated: null },
            operationalState: { mode: "normal", pressure: 0 },
            openQuestions: [], impasses: [], metacognition: emptyMetacognitiveState(),
            coordination: { rootWorkerId, plannerWorkerId: planner.id, planId, subtaskId: spec.id },
            recovery: { interruptedFrom: null, recoveredAt: null },
            createdAt: now, updatedAt: now, revision: 0
        };
    }
    requireSharedPlan(sender, recipient, planId) {
        const object = this.mentalObjects.get(planId);
        if (!object)
            throw new NotFoundError("MentalObject", planId);
        const plan = readParallelPlan(object);
        if (!plan || object.workerId !== plan.plannerWorkerId)
            throw new TypeError("Mental object is not a parallel plan");
        const participants = new Set([plan.plannerWorkerId, ...plan.subtasks.map((entry) => entry.workerId)]);
        if (!participants.has(sender.id) || !participants.has(recipient.id)) {
            throw new TypeError("Workers do not participate in the same parallel plan");
        }
        return { object, plan };
    }
    cascadeBlockedFailures(plan, failedSubtaskId, now) {
        const failed = new Set([failedSubtaskId]);
        const workerIds = [];
        let changed = true;
        while (changed) {
            changed = false;
            for (const candidate of plan.subtasks) {
                if ((candidate.status === "blocked" || candidate.status === "ready") && candidate.dependencies.some((id) => failed.has(id))) {
                    candidate.status = "failed";
                    candidate.summary = `Blocked by failed dependency: ${candidate.dependencies.filter((id) => failed.has(id)).join(", ")}`;
                    candidate.completedAt = now;
                    failed.add(candidate.id);
                    workerIds.push(candidate.workerId);
                    changed = true;
                }
            }
        }
        return workerIds;
    }
}
//# sourceMappingURL=coordination.js.map