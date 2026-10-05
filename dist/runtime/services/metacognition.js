// Metacognition: assessing each cognitive cycle, calibrating model
// confidence against outcomes, and resolving or escalating impasses.
import { routeEscalation } from "../../models/escalation.js";
import { assessCycle, emptyMetacognitiveState } from "../../metacognition/assessment.js";
import { calibrateConfidence, recordCalibration } from "../../metacognition/calibration.js";
import { allowedTransitions, assertTransition } from "../state-machine.js";
import { RuntimeService } from "../core.js";
export class MetacognitionService extends RuntimeService {
    runtime;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async completeCycle(workerId, input = {}) {
        const current = this.workers.require(workerId);
        const now = new Date().toISOString();
        const madeProgress = input.madeProgress === true;
        const scoreDelta = Number(input.scoreDelta ?? (madeProgress ? 1 : 0));
        if (!Number.isFinite(scoreDelta))
            throw new TypeError("scoreDelta must be a finite number");
        const objects = this.mentalObjects.listForWorker(workerId);
        const assessed = this.config.metacognition.enabled ? assessCycle({
            worker: current,
            objects,
            madeProgress,
            ...(input.action !== undefined ? { action: input.action } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
            ...(input.validAction !== undefined ? { validAction: input.validAction } : {}),
            ...(input.resourceAvailable !== undefined ? { resourceAvailable: input.resourceAvailable } : {}),
            ...(input.strategyExhausted !== undefined ? { strategyExhausted: input.strategyExhausted } : {}),
            ...(input.procedureValid !== undefined ? { procedureValid: input.procedureValid } : {}),
            ...(input.worldModelSufficient !== undefined ? { worldModelSufficient: input.worldModelSufficient } : {}),
            at: now,
            config: this.config.metacognition
        }) : null;
        const currentActiveImpasse = current.metacognition?.activeImpasseId
            ? this.mentalObjects.get(current.metacognition.activeImpasseId) : null;
        const shouldCreateImpasse = Boolean(assessed && this.config.metacognition.impasseDetectionEnabled && assessed.assessment.reasons.length
            && (!currentActiveImpasse || currentActiveImpasse.data.status !== "active"));
        const impasse = shouldCreateImpasse ? this.makeMentalObjectRecord({
            workerId,
            kind: "impasse",
            content: `Worker blocked: ${assessed.assessment.reasons.join(", ")}`,
            data: {
                status: "active",
                reasons: assessed.assessment.reasons,
                responses: assessed.assessment.responses,
                signals: assessed.assessment.signals,
                stateSignature: assessed.assessment.signature,
                detectedAtCycle: current.progress.cycle + 1,
                resolvedAt: null,
                resolution: null
            },
            confidence: 1,
            importance: 1,
            memoryRoles: ["episodic"],
            actor: { kind: "runtime", source: "metacognition", correlationId: input.actor?.correlationId ?? null }
        }, now) : null;
        const metacognition = assessed ? {
            ...assessed.state,
            activeImpasseId: impasse?.id ?? (currentActiveImpasse?.data.status === "active" ? currentActiveImpasse.id : null)
        } : current.metacognition;
        const markImpassse = Boolean(impasse && allowedTransitions(current.status).includes("impasse"));
        const updated = {
            ...current,
            status: markImpassse ? "impasse" : current.status,
            progress: {
                cycle: current.progress.cycle + 1,
                lastProgressAt: madeProgress ? now : current.progress.lastProgressAt,
                score: Math.max(0, current.progress.score + scoreDelta)
            },
            ...(metacognition ? { metacognition } : {}),
            impasses: impasse ? [...current.impasses, impasse.id] : current.impasses,
            updatedAt: now,
            revision: current.revision + 1
        };
        const event = this.makeEvent(workerId, "worker.cycle-completed", {
            cycle: updated.progress.cycle, madeProgress, score: updated.progress.score,
            stateSignature: assessed?.assessment.signature ?? null
        }, input.actor ?? {}, now);
        const assessmentEvent = assessed ? this.makeEvent(workerId, "metacognition.assessed", {
            cycle: updated.progress.cycle,
            cyclesWithoutProgress: assessed.assessment.cyclesWithoutProgress,
            repeatedStateCount: assessed.assessment.repeatedStateCount,
            reasons: assessed.assessment.reasons,
            impasseId: impasse?.id ?? null
        }, { kind: "runtime", source: "metacognition", correlationId: input.actor?.correlationId ?? null }, now) : null;
        const impasseEvent = impasse ? this.makeEvent(workerId, "impasse-detected", {
            impasseId: impasse.id,
            reasons: assessed.assessment.reasons,
            responses: assessed.assessment.responses,
            cycle: updated.progress.cycle
        }, { kind: "runtime", source: "metacognition", correlationId: input.actor?.correlationId ?? null }, now) : null;
        const persistedEvents = this.database.transaction(() => {
            if (impasse)
                this.mentalObjects.insert(impasse);
            this.workers.update(updated, current.revision);
            return [event, assessmentEvent, impasseEvent].filter((candidate) => Boolean(candidate))
                .map((candidate) => this.eventBus.persist(candidate));
        });
        for (const persistedEvent of persistedEvents)
            await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("worker.cycles");
        if (impasse)
            this.telemetry.increment("impasses.detected");
        return updated;
    }
    async recordModelOutcome(input) {
        if (!this.config.metacognition.enabled)
            throw new TypeError("Metacognition is disabled");
        const current = this.workers.require(input.workerId);
        const processorId = input.processorId.trim();
        if (!processorId)
            throw new TypeError("processorId is required");
        if (input.sourceObjectId)
            this.requireOwnedObject(input.workerId, input.sourceObjectId);
        const now = new Date().toISOString();
        const profiles = current.confidence.calibration ?? {};
        const profile = recordCalibration({
            processorId,
            reportedConfidence: input.reportedConfidence,
            reward: input.reward,
            ...(input.sourceObjectId !== undefined ? { sourceObjectId: input.sourceObjectId } : {}),
            at: now,
            ...(profiles[processorId] ? { current: profiles[processorId] } : {}),
            config: this.config.metacognition
        });
        const calibrated = calibrateConfidence(input.reportedConfidence, profile, this.config.metacognition.calibrationMinimumSamples);
        const updated = {
            ...current,
            confidence: {
                overall: Math.min(1, Math.max(0, input.reportedConfidence)),
                calibrated,
                calibration: { ...profiles, [processorId]: profile }
            },
            updatedAt: now,
            revision: current.revision + 1
        };
        const event = this.makeEvent(input.workerId, "confidence.calibrated", {
            processorId,
            reportedConfidence: input.reportedConfidence,
            reward: input.reward,
            calibratedConfidence: calibrated,
            bias: profile.bias,
            reliability: profile.reliability,
            sampleCount: profile.samples.length,
            sourceObjectId: input.sourceObjectId ?? null
        }, input.actor ?? { kind: "runtime", source: "metacognition" }, now);
        const persisted = this.database.transaction(() => {
            this.workers.update(updated, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
        this.telemetry.increment("confidence.calibration.samples");
        return { profile, worker: updated };
    }
    async resolveImpasse(input) {
        const current = this.workers.require(input.workerId);
        const impasse = this.requireOwnedObject(input.workerId, input.impasseId);
        if (impasse.kind !== "impasse" || !current.impasses.includes(impasse.id))
            throw new TypeError("Impasse does not belong to this worker");
        if (impasse.data.status !== "active")
            throw new TypeError("Impasse is already resolved");
        const resolution = input.resolution.trim();
        if (!resolution)
            throw new TypeError("Impasse resolution is required");
        const nextStatus = input.nextStatus ?? (current.status === "impasse" ? "ready" : current.status);
        if (nextStatus !== current.status)
            assertTransition(current.status, nextStatus);
        const now = new Date().toISOString();
        const updatedImpasse = {
            ...impasse,
            data: { ...impasse.data, status: "resolved", resolvedAt: now, resolution },
            status: "archived",
            lastAccessedAt: now
        };
        const updatedWorker = {
            ...current,
            status: nextStatus,
            metacognition: { ...(current.metacognition ?? emptyMetacognitiveState()), activeImpasseId: null, cyclesWithoutProgress: 0, repeatedStateCount: 0, lastAssessmentAt: now },
            updatedAt: now,
            revision: current.revision + 1
        };
        const event = this.makeEvent(input.workerId, "impasse.resolved", { impasseId: impasse.id, resolution, nextStatus }, input.actor ?? {}, now);
        const persisted = this.database.transaction(() => {
            this.mentalObjects.update(updatedImpasse);
            this.workers.update(updatedWorker, current.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
        this.telemetry.increment("impasses.resolved");
        return { impasse: updatedImpasse, worker: updatedWorker };
    }
    async consultOnImpasse(input) {
        if (!this.config.modelEscalation.enabled)
            throw new TypeError("Model escalation is disabled");
        const worker = this.workers.require(input.workerId);
        const impasse = this.requireOwnedObject(input.workerId, input.impasseId);
        if (impasse.kind !== "impasse" || impasse.data.status !== "active" || worker.metacognition?.activeImpasseId !== impasse.id) {
            throw new TypeError("Escalation requires the Worker's active Impasse");
        }
        const assigned = worker.modelAssignment
            ? this.runtime.modelRegistry.select({ id: worker.modelAssignment.processorId })
            : this.runtime.modelRegistry.select({ ...(input.specialty ? { specialty: input.specialty } : {}) });
        const route = routeEscalation({
            processors: this.runtime.modelRegistry.generative(),
            fromTier: assigned.tier,
            ...(input.specialty ? { specialty: input.specialty } : {}),
            ...(input.minimumContextSize !== undefined ? { minimumContextSize: input.minimumContextSize } : {}),
            ...(worker.confidence.calibration ? { calibration: worker.confidence.calibration } : {}),
            config: this.config.modelEscalation
        });
        const release = this.runtime.tierScheduler.tryAcquire(route.toTier);
        const actor = input.actor ?? { kind: "runtime", source: "model-escalation" };
        if (!release) {
            const now = new Date().toISOString();
            const event = this.makeEvent(input.workerId, "model.escalation-deferred", {
                impasseId: impasse.id, fromProcessorId: assigned.id, toProcessorId: route.processor.id,
                fromTier: assigned.tier, toTier: route.toTier, reason: "tier-busy"
            }, actor, now);
            await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(event)));
            this.telemetry.increment("model.escalations.deferred");
            return { status: "deferred", fromProcessorId: assigned.id, toProcessorId: route.processor.id, reason: "tier-busy" };
        }
        const startedAt = new Date().toISOString();
        const escalationEvent = this.makeEvent(input.workerId, "model.escalated", {
            impasseId: impasse.id, fromProcessorId: assigned.id, toProcessorId: route.processor.id,
            fromTier: assigned.tier, toTier: route.toTier, routingReliability: route.reliability,
            cause: impasse.data.reasons ?? []
        }, actor, startedAt);
        await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(escalationEvent)));
        this.telemetry.increment("model.escalations.started");
        try {
            const result = await this.runtime.inferForWorker({
                workerId: input.workerId,
                processorId: route.processor.id,
                specialty: input.specialty ?? "planning",
                instruction: input.instruction?.trim() || `Resolve this Impasse without changing the Worker's objective. Reasons: ${String(impasse.data.reasons ?? "unknown")}. Propose a concrete next action and supporting rationale.`,
                actor
            });
            let reflection = {
                ...result.object,
                data: {
                    ...result.object.data,
                    escalation: {
                        impasseId: impasse.id,
                        fromProcessorId: assigned.id,
                        toProcessorId: route.processor.id,
                        fromTier: assigned.tier,
                        toTier: route.toTier,
                        temporary: true
                    }
                },
                associations: [...result.object.associations, {
                        targetId: impasse.id, kind: "derived-from", strength: 1, lastCoactivatedAt: new Date().toISOString()
                    }]
            };
            this.mentalObjects.update(reflection);
            if (this.config.modelEscalation.admitConsultationToWorkingMemory) {
                await this.runtime.competeForWorkingMemory({
                    workerId: input.workerId,
                    candidateIds: [reflection.id],
                    actor: { kind: "runtime", source: "model-escalation" }
                });
                reflection = this.mentalObjects.get(reflection.id);
            }
            const latestImpasse = this.mentalObjects.get(impasse.id);
            const consultations = Array.isArray(latestImpasse.data.consultations) ? latestImpasse.data.consultations : [];
            const completedAt = new Date().toISOString();
            this.mentalObjects.update({
                ...latestImpasse,
                data: {
                    ...latestImpasse.data,
                    consultations: [...consultations, {
                            reflectionId: reflection.id, processorId: route.processor.id, tier: route.toTier,
                            startedAt, completedAt
                        }]
                },
                lastAccessedAt: completedAt
            });
            const deescalationEvent = this.makeEvent(input.workerId, "model.deescalated", {
                impasseId: impasse.id, reflectionId: reflection.id,
                releasedProcessorId: route.processor.id,
                resumedProcessorId: worker.modelAssignment?.processorId ?? assigned.id,
                resumedTier: worker.modelAssignment?.tier ?? assigned.tier,
                outcome: "completed"
            }, actor, completedAt);
            await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(deescalationEvent)));
            this.telemetry.increment("model.escalations.completed");
            return {
                status: "completed",
                fromProcessorId: assigned.id,
                toProcessorId: route.processor.id,
                reflection,
                worker: this.workers.require(input.workerId)
            };
        }
        catch (error) {
            const failedAt = new Date().toISOString();
            const event = this.makeEvent(input.workerId, "model.deescalated", {
                impasseId: impasse.id, releasedProcessorId: route.processor.id,
                resumedProcessorId: worker.modelAssignment?.processorId ?? assigned.id,
                outcome: "failed", error: error instanceof Error ? error.message : String(error)
            }, actor, failedAt);
            await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(event)));
            this.telemetry.increment("model.escalations.failed");
            throw error;
        }
        finally {
            release();
        }
    }
}
//# sourceMappingURL=metacognition.js.map