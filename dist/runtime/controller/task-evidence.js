// The task's evidence ledger: each message the user sends is recorded once as
// evidence, apart from facts about the user, and the hypotheses the task holds
// are weighed against it.
// Shortcut S17 (docs/COGNITIVE_SHORTCUTS.md): how much a user's message is
// trusted as evidence, how strongly one independent check moves a hypothesis,
// and how many hypotheses a task holds at once.
export const TASK_EVIDENCE_SOURCE = "user message";
export const USER_OBSERVATION_RELIABILITY = 0.8;
export const HYPOTHESIS_CHECK_STRENGTH = 1;
export const MAXIMUM_ACTIVE_HYPOTHESES = 6;
export class TaskEvidence {
    runtime;
    view;
    constructor(runtime, view) {
        this.runtime = runtime;
        this.view = view;
    }
    // The user's messages recorded as evidence, in the order they were
    // recorded (the worker's evidence list keeps it exactly; timestamps can tie).
    // A copy shared from a subtask is not something the user said to this task.
    messages(worker) {
        const order = new Map((this.runtime.getWorker(worker.id)?.evidence ?? []).map((id, index) => [id, index]));
        return this.runtime.mentalObjects.listForWorker(worker.id)
            .filter((object) => object.kind === "evidence" && object.data.source === TASK_EVIDENCE_SOURCE && object.data.sharedEvidence !== true)
            .sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity) || left.createdAt.localeCompare(right.createdAt));
    }
    // Everything the user has said in the conversation is evidence for the
    // task answering it, not only the messages this task received: a
    // conversation may span several tasks, and a task that saw only its own
    // messages would reason over a fragment. Recorded oldest first, each once,
    // with the current message last.
    async ingestConversation(worker) {
        const turns = this.runtime.getWorker(worker.id)?.worldState["genesis.conversationTurns"]?.value;
        const said = (Array.isArray(turns) ? turns : [])
            .filter((turn) => Boolean(turn) && typeof turn === "object" && turn.role === "user")
            .map((turn) => String(turn.content ?? "").trim())
            .filter(Boolean);
        const recorded = new Set(this.messages(worker).map((object) => object.content));
        for (const message of [...said, this.view.currentMessage(worker)]) {
            if (recorded.has(message))
                continue;
            recorded.add(message);
            await this.runtime.recordEvidence({
                workerId: worker.id, content: message, source: TASK_EVIDENCE_SOURCE, reliability: USER_OBSERVATION_RELIABILITY,
                actor: { kind: "user", source: "speck-controller:task-evidence" }
            });
        }
    }
    // The evidence Speck recorded from the user's current message.
    currentEvidenceId(worker) {
        const message = this.view.currentMessage(worker);
        return this.runtime.mentalObjects.listForWorker(worker.id)
            .find((object) => object.kind === "evidence" && object.data.source === TASK_EVIDENCE_SOURCE && object.content === message)?.id ?? null;
    }
    activeHypotheses(worker) {
        return this.runtime.mentalObjects.listForWorker(worker.id)
            .filter((object) => object.kind === "hypothesis" && !["rejected", "superseded"].includes(String(object.data.status)));
    }
    // The evidence the task holds and where each hypothesis stands. A cycle
    // that changes it made progress, even if its reply is not accepted.
    epistemicSignature(worker) {
        return this.runtime.mentalObjects.listForWorker(worker.id)
            .filter((object) => object.kind === "evidence" || object.kind === "hypothesis")
            .map((object) => object.kind === "evidence" ? object.id : `${object.id}:${String(object.data.status)}:${object.confidence.toFixed(2)}`)
            .sort().join("|");
    }
}
//# sourceMappingURL=task-evidence.js.map