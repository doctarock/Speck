// How a run ends: the task completes with a result, or waits for the user.
import { normalizedKey } from "./statements.js";
import { actor } from "./support.js";
export class Settlement {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    // "blocked": progress needs information only the user has. "awaiting-input":
    // the task holds a provisional answer and expects more from the user.
    async waitForUser(input, question, kind = "blocked") {
        let worker = this.runtime.getWorker(input.id);
        await this.runtime.setWorldState({ workerId: worker.id, key: "genesis.questionForUser", value: question, epistemicStatus: "observed", confidence: 1, actor: actor("controller") });
        await this.runtime.setWorldState({ workerId: worker.id, key: "genesis.waitKind", value: kind, epistemicStatus: "observed", confidence: 1, actor: actor("controller") });
        worker = this.runtime.getWorker(worker.id);
        if (worker.status !== "waiting")
            worker = await this.runtime.transitionWorker(worker.id, "waiting", actor("controller"), question);
        return { status: "waiting", worker, summary: question };
    }
    async complete(input, summary, source, reason, domain, persistLearning = true, forceCompletionMemory = false) {
        let worker = this.runtime.getWorker(input.id);
        await this.runtime.setWorldState({ workerId: worker.id, key: "genesis.resultSummary", value: summary, epistemicStatus: "observed", confidence: source?.confidence ?? 1, actor: actor("controller") });
        worker = this.runtime.getWorker(worker.id);
        if (worker.status === "orienting" || worker.status === "planning" || worker.status === "ready")
            worker = await this.runtime.transitionWorker(worker.id, "executing", actor("controller"), reason);
        worker = await this.runtime.completeCycle(worker.id, { madeProgress: true, scoreDelta: 1, action: "complete", actor: actor("controller") });
        if (worker.status === "executing")
            worker = await this.runtime.transitionWorker(worker.id, "evaluating", actor("controller"), "Validating completion");
        if (worker.status === "evaluating")
            worker = await this.runtime.transitionWorker(worker.id, "completed", actor("controller"), reason);
        const retainOrdinary = persistLearning && (forceCompletionMemory || this.runtime.memoryAdmissionPolicy.ordinaryCompletions);
        if (!retainOrdinary)
            return { status: "completed", worker: this.runtime.getWorker(worker.id), summary };
        const durableContent = `Validated result for ${worker.objective.description}: ${summary}`;
        await this.runtime.recordSharedMemory({
            type: "episodic", content: `Objective: ${worker.objective.description}\nResult: ${summary}`,
            sourceWorkerId: worker.id, audience: worker.coordination ? ["planner", "worker"] : ["intake", "planner", "worker"],
            confidence: source?.confidence ?? 0.5, importance: worker.coordination ? 0.55 : 0.75,
            data: { conversationResult: true, objective: worker.objective.description, result: summary, admissionCategory: forceCompletionMemory ? "ordinaryConversation" : "ordinaryCompletions" },
            actor: actor("shared-memory:result")
        });
        const semantic = await this.runtime.recordMemory({
            workerId: worker.id, type: "semantic",
            content: durableContent,
            confidence: source?.confidence ?? 0.7, importance: 0.9,
            data: { verification: "completion-gate", objective: worker.objective.description, result: summary },
            actor: actor("semantic-result")
        });
        await this.runtime.recordSharedMemory({
            type: "semantic", content: semantic.content, sourceWorkerId: worker.id,
            audience: ["intake", "planner", "worker"], confidence: semantic.confidence, importance: semantic.importance,
            data: { verification: "completion-gate", sourceObjectId: semantic.id }, actor: actor("shared-semantic-result")
        });
        if (this.runtime.config.memoryActivation.domainAnchorsEnabled && this.runtime.config.memoryActivation.associativeEdgesEnabled) {
            await this.runtime.linkMemoryToDomain({ workerId: worker.id, objectId: semantic.id, domain, key: normalizedKey(worker.objective.description), actor: actor("domain-learning") });
        }
        worker = this.runtime.getWorker(worker.id);
        return { status: "completed", worker, summary };
    }
}
//# sourceMappingURL=settlement.js.map