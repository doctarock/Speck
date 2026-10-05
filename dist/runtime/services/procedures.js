// Procedures and Known Answers: compiled from validated demonstrations, and
// run as fast paths with feedback from their outcomes.
import { randomUUID } from "node:crypto";
import { applyProcedureFeedback, conditionsMatch, findCompiledProcedure, findKnownAnswer, normalizeTrigger, procedureSignature, readProcedure } from "../../procedure/engine.js";
import { bounded, isRecord, RuntimeService } from "../core.js";
export class ProcedureService extends RuntimeService {
    runtime;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async recordProcedureDemonstration(input) {
        if (!this.config.procedures.enabled)
            throw new TypeError("Procedures are disabled");
        const worker = this.workers.require(input.workerId);
        const episode = this.requireOwnedObject(input.workerId, input.episodeId);
        if (!verifiedSuccessfulEpisode(episode))
            throw new TypeError("Procedure demonstrations require an externally verified successful episode");
        if (!input.steps.length)
            throw new TypeError("A procedure requires at least one step");
        const trigger = normalizeTrigger(input.trigger);
        if (!trigger)
            throw new TypeError("Procedure trigger is required");
        validateProcedureSteps(input.steps);
        const preconditions = input.preconditions ?? [];
        const validators = input.validators ?? [];
        // Reuse the structured comparison validator at compilation time; an
        // invalid guard must never become a latent runtime shortcut.
        conditionsMatch(preconditions, {});
        conditionsMatch(validators, {});
        const signature = procedureSignature(trigger, input.steps, preconditions);
        const objects = this.mentalObjects.listForWorker(input.workerId);
        const sameTrigger = objects.filter((object) => readProcedure(object)?.trigger.value === trigger && object.status === "active");
        let current = sameTrigger.find((object) => object.data.signature === signature) ?? null;
        if (current && readProcedure(current).creditedEpisodeIds.includes(episode.id))
            return current;
        const now = new Date().toISOString();
        const credited = current ? [...readProcedure(current).creditedEpisodeIds, episode.id] : [episode.id];
        const ambiguous = sameTrigger.some((object) => object.data.signature !== signature);
        const status = !ambiguous && credited.length >= this.config.procedures.compilationThreshold ? "compiled" : "candidate";
        const definition = {
            schema: "speck-procedure/v1",
            trigger: { kind: "exact-normalized", value: trigger },
            preconditions: structuredClone(preconditions),
            steps: structuredClone(input.steps),
            validators: structuredClone(validators),
            failureRoutes: [...(input.failureRoutes ?? ["reasoning-fallback"])],
            status,
            verifiedSuccesses: credited.length,
            creditedEpisodeIds: credited,
            successCount: current ? readProcedure(current).successCount : 0,
            failureCount: current ? readProcedure(current).failureCount : 0,
            utility: current ? readProcedure(current).utility : this.config.procedures.initialUtility,
            executionHistory: current ? readProcedure(current).executionHistory : []
        };
        let procedure = current ? {
            ...current, data: { ...definition, signature }, confidence: Math.min(1, credited.length / this.config.procedures.compilationThreshold), lastAccessedAt: now
        } : this.makeMentalObjectRecord({
            workerId: input.workerId, kind: "procedure", content: `Procedure for: ${trigger}`,
            data: { ...definition, signature }, confidence: Math.min(1, credited.length / this.config.procedures.compilationThreshold),
            importance: 0.7, memoryRoles: ["procedural"], actor: input.actor ?? { kind: "runtime", source: "procedure-learning" }
        }, now);
        const demoted = ambiguous ? sameTrigger.filter((object) => readProcedure(object)?.status === "compiled").map((object) => ({
            ...object, data: { ...object.data, status: "candidate", ambiguous: true }, lastAccessedAt: now
        })) : [];
        if (ambiguous)
            procedure = { ...procedure, data: { ...procedure.data, ambiguous: true } };
        const eventType = status === "compiled" ? "procedure.compiled" : "procedure.candidate";
        const event = this.makeEvent(input.workerId, eventType, { procedureId: procedure.id, trigger, verifiedSuccesses: credited.length, status, ambiguous }, input.actor ?? {}, now);
        const persisted = this.database.transaction(() => {
            if (current)
                this.mentalObjects.update(procedure);
            else
                this.mentalObjects.insert(procedure);
            for (const object of demoted)
                this.mentalObjects.update(object);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
        this.telemetry.increment(`procedures.${status}`);
        return procedure;
    }
    async executeProcedure(input) {
        if (!this.config.procedures.enabled)
            throw new TypeError("Procedures are disabled");
        const worker = this.workers.require(input.workerId);
        const procedure = findCompiledProcedure(this.mentalObjects.listForWorker(input.workerId), input.trigger);
        if (!procedure)
            return { matched: false, procedure: null, successful: false, outputs: [], reason: "no-unambiguous-procedure" };
        const definition = readProcedure(procedure);
        const state = procedureState(worker);
        if (!conditionsMatch(definition.preconditions, state)) {
            return { matched: true, procedure, successful: false, outputs: [], reason: "precondition-failed" };
        }
        try {
            // Validate every tool and permission before step one so a multi-step
            // procedure cannot partially execute and only then discover that a
            // later step lacked authority. Missing authorization is not evidence
            // that the learned procedure itself is bad, so it receives no utility
            // penalty.
            for (const step of definition.steps) {
                if (step.kind !== "tool")
                    continue;
                const registered = this.runtime.toolRegistry.resolve(step.intent);
                this.runtime.toolRegistry.validateArguments(registered.definition, step.intent.arguments);
                this.runtime.toolRegistry.assertAuthorized(registered.definition, input.authorization);
            }
        }
        catch (error) {
            return {
                matched: true, procedure, successful: false, outputs: [],
                reason: error instanceof Error ? error.message : String(error)
            };
        }
        const executionId = randomUUID();
        const started = Date.now();
        const outputs = [];
        let successful = true;
        let reason = null;
        try {
            for (const step of definition.steps) {
                if (step.kind === "answer")
                    outputs.push({ kind: "answer", text: step.text });
                else {
                    const result = await this.runtime.executeToolIntent({
                        workerId: input.workerId, intent: step.intent,
                        ...(input.authorization ? { authorization: input.authorization } : {}),
                        actor: input.actor ?? { kind: "runtime", source: `procedure:${procedure.id}` }
                    });
                    outputs.push(result.record);
                    if (result.record.actualOutcome !== "succeeded") {
                        successful = false;
                        reason = result.record.actualOutcome;
                        break;
                    }
                }
            }
            const latestWorker = this.workers.require(input.workerId);
            if (successful && !conditionsMatch(definition.validators, { ...procedureState(latestWorker), outputs, lastOutput: outputs.at(-1) })) {
                successful = false;
                reason = "validator-failed";
            }
        }
        catch (error) {
            successful = false;
            reason = error instanceof Error ? error.message : String(error);
        }
        const updated = await this.applyProcedureExecutionFeedback({
            workerId: input.workerId, procedureId: procedure.id, executionId, successful,
            durationMs: Math.max(0, Date.now() - started), modelInterventions: 0,
            ...(input.actor ? { actor: input.actor } : {})
        });
        const now = new Date().toISOString();
        const event = this.makeEvent(input.workerId, "procedure.executed", {
            procedureId: procedure.id, executionId, successful, reason, stepCount: definition.steps.length,
            llmCalls: 0, utility: readProcedure(updated).utility
        }, input.actor ?? {}, now);
        await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(event)));
        this.telemetry.increment("procedures.executions");
        this.telemetry.increment(successful ? "procedures.successes" : "procedures.failures");
        this.telemetry.increment("llm.calls.avoided");
        return { matched: true, procedure: updated, successful, outputs, reason };
    }
    async recordKnownAnswer(input) {
        if (!this.config.procedures.enabled)
            throw new TypeError("Procedures are disabled");
        this.workers.require(input.workerId);
        const source = this.requireOwnedObject(input.workerId, input.sourceObjectId);
        const query = normalizeTrigger(input.query);
        const answer = input.answer.trim();
        if (!query || !answer)
            throw new TypeError("Known Answer query and answer are required");
        const keys = [...new Set([query, ...(input.aliases ?? []).map(normalizeTrigger).filter(Boolean)])];
        const now = new Date().toISOString();
        const object = this.makeMentalObjectRecord({
            workerId: input.workerId, kind: "known-answer", content: answer,
            data: { schema: "speck-known-answer/v1", keys, answer, sourceObjectId: source.id },
            confidence: bounded(input.confidence ?? source.confidence, "confidence"), importance: 0.6,
            memoryRoles: ["known-answer", "semantic"], actor: input.actor ?? { kind: "runtime", source: "known-answer" }
        }, now);
        const event = this.makeEvent(input.workerId, "known-answer.recorded", { objectId: object.id, keys, sourceObjectId: source.id }, input.actor ?? {}, now);
        const persisted = this.database.transaction(() => { this.mentalObjects.insert(object); return this.eventBus.persist(event); });
        await this.eventBus.dispatch(persisted);
        return object;
    }
    async retrieveKnownAnswer(workerId, query, actor = {}) {
        this.workers.require(workerId);
        const answer = findKnownAnswer(this.mentalObjects.listForWorker(workerId), query, this.config.procedures.knownAnswerMinimumConfidence);
        if (!answer)
            return null;
        const now = new Date().toISOString();
        const updated = { ...answer, lastAccessedAt: now };
        const event = this.makeEvent(workerId, "known-answer.hit", { objectId: answer.id, query: normalizeTrigger(query), llmCalls: 0 }, actor, now);
        const persisted = this.database.transaction(() => { this.mentalObjects.update(updated); return this.eventBus.persist(event); });
        await this.eventBus.dispatch(persisted);
        this.telemetry.increment("known_answers.hits");
        this.telemetry.increment("llm.calls.avoided");
        return updated;
    }
    async applyProcedureExecutionFeedback(input) {
        const current = this.requireOwnedObject(input.workerId, input.procedureId);
        const definition = readProcedure(current);
        if (!definition)
            throw new TypeError("Mental object is not a procedure");
        if (definition.executionHistory.some((entry) => entry.executionId === input.executionId))
            return current;
        const now = new Date().toISOString();
        const revised = applyProcedureFeedback(definition, input.successful, {
            executionId: input.executionId, durationMs: input.durationMs,
            modelInterventions: input.modelInterventions, at: now
        }, this.config.procedures);
        const updated = {
            ...current, data: { ...current.data, ...revised }, confidence: Math.min(1, Math.max(0.05, revised.utility)),
            status: revised.status === "deprecated" ? "archived" : current.status, lastAccessedAt: now
        };
        const event = this.makeEvent(input.workerId, "procedure.feedback", {
            procedureId: current.id, executionId: input.executionId, successful: input.successful,
            utility: revised.utility, status: revised.status
        }, input.actor ?? {}, now);
        const persisted = this.database.transaction(() => { this.mentalObjects.update(updated); return this.eventBus.persist(event); });
        await this.eventBus.dispatch(persisted);
        return updated;
    }
}
function verifiedSuccessfulEpisode(object) {
    if (object.provenance.kind === "model")
        return false;
    if (object.kind === "tool-outcome") {
        const invocation = isRecord(object.data.toolInvocation) ? object.data.toolInvocation : null;
        return invocation?.actualOutcome === "succeeded";
    }
    if (object.kind === "evidence")
        return Number(object.data.reliability ?? 0) >= 0.8
            && ["tool", "user", "external", "runtime"].includes(object.provenance.kind);
    return object.kind === "observation" && ["tool", "user", "external"].includes(object.provenance.kind);
}
function validateProcedureSteps(steps) {
    for (const step of steps) {
        if (step.kind === "answer") {
            if (!step.text.trim())
                throw new TypeError("Procedure answer steps require text");
        }
        else if (step.kind === "tool") {
            if (!step.intent.intent.trim() || !step.intent.expectedOutcome.trim() || !isRecord(step.intent.arguments)) {
                throw new TypeError("Procedure tool steps require a semantic intent, arguments, and expected outcome");
            }
        }
        else
            throw new TypeError("Unknown procedure step");
    }
}
function procedureState(worker) {
    return {
        objective: worker.objective,
        status: worker.status,
        worldState: Object.fromEntries(Object.entries(worker.worldState).map(([key, entry]) => [key, entry.value])),
        confidence: worker.confidence,
        operationalState: worker.operationalState
    };
}
//# sourceMappingURL=procedures.js.map