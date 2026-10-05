// Worker orchestration for the interface (no HTTP): creating and continuing
// conversation workers, running them through the controller, and the queue.
import { SpeckController } from "../runtime/controller.js";
import { TASK_EVIDENCE_SOURCE } from "../runtime/controller/task-evidence.js";
import { parseWorkerId } from "../types/ids.js";
import { resultSummary, waitingQuestion, errorMessage } from "./presentation.js";
export async function createReadyWorker(runtime, objective, sessionId, processorId, conversation = []) {
    let worker = await runtime.createWorker(objective, [], {
        kind: "user", source: "genesis-gui", actorId: String(sessionId ?? "Main")
    });
    if (conversation.length) {
        const context = await runtime.createMentalObject({
            workerId: worker.id,
            kind: "observation",
            content: `Recent conversation for interpreting the current request:\n${conversation.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`).join("\n")}`,
            confidence: 1,
            importance: 0.9,
            memoryRoles: ["working"],
            data: { conversationContext: true, sessionId: String(sessionId ?? "Main"), turns: conversation },
            actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(sessionId ?? "Main") }
        });
        await runtime.admitToWorkingMemory(worker.id, context.id, {
            kind: "runtime", source: "genesis-gui:conversation-context", actorId: String(sessionId ?? "Main")
        });
        await runtime.setWorldState({
            workerId: worker.id,
            key: "genesis.conversationTurns",
            value: conversation,
            epistemicStatus: "observed",
            confidence: 1,
            actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(sessionId ?? "Main") }
        });
        worker = runtime.getWorker(worker.id);
    }
    if (runtime.memoryAdmissionPolicy.rawPrompts) {
        await runtime.recordSharedMemory({
            type: "episodic", content: objective, sourceWorkerId: worker.id,
            audience: ["intake", "planner", "worker"], confidence: 1, importance: 0.65,
            data: { admissionCategory: "rawPrompts", sessionId: String(sessionId ?? "Main") },
            actor: { kind: "user", source: "genesis-gui", actorId: String(sessionId ?? "Main") }
        });
    }
    worker = await runtime.transitionWorker(worker.id, "ready", { kind: "runtime", source: "genesis-task-adapter" }, "Admitted to task queue");
    const requested = String(processorId ?? "").trim();
    if (requested && runtime.modelRegistry.has(requested)) {
        worker = await runtime.assignModelProcessor(worker.id, requested, { kind: "user", source: "genesis-gui" });
    }
    return worker;
}
export async function recordConversationContinuation(runtime, worker, answer, sessionId) {
    const currentTurns = normalizeConversationTurns(worker.worldState["genesis.conversationTurns"]?.value);
    const priorQuestion = waitingQuestion(worker).trim();
    const lastTurn = currentTurns.at(-1);
    if (priorQuestion && !(lastTurn?.role === "assistant" && lastTurn.content === priorQuestion)) {
        currentTurns.push({ role: "assistant", content: priorQuestion });
    }
    currentTurns.push({ role: "user", content: answer });
    const turns = normalizeConversationTurns(currentTurns);
    await runtime.setWorldState({
        workerId: worker.id,
        key: "genesis.conversationTurns",
        value: turns,
        epistemicStatus: "observed",
        confidence: 1,
        actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(sessionId ?? "Main") }
    });
    // The new message is what the next cycle answers; the objective stays the
    // task's original request.
    await runtime.setWorldState({
        workerId: worker.id,
        key: "genesis.currentMessage",
        value: answer,
        epistemicStatus: "observed",
        confidence: 1,
        actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(sessionId ?? "Main") }
    });
    const retain = runtime.memoryAdmissionPolicy.rawPrompts;
    const memory = await runtime.createMentalObject({
        workerId: worker.id,
        kind: "observation",
        content: answer,
        data: { genesisTaskAnswer: true, conversationContinuation: true, sessionId: String(sessionId ?? "Main") },
        confidence: 1,
        importance: 1,
        memoryRoles: retain ? ["working", "episodic"] : ["working"],
        actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(sessionId ?? "Main") }
    });
    await runtime.admitToWorkingMemory(worker.id, memory.id, {
        kind: "runtime", source: "genesis-gui:conversation-context", actorId: String(sessionId ?? "Main")
    });
    if (retain) {
        await runtime.recordSharedMemory({
            type: "episodic", content: answer, sourceWorkerId: worker.id,
            audience: ["planner", "worker"], confidence: 1, importance: 0.7,
            data: { admissionCategory: "rawPrompts", conversationContinuation: true, objective: worker.objective.description },
            actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(sessionId ?? "Main") }
        });
    }
}
export function normalizeConversationTurns(value) {
    if (!Array.isArray(value))
        return [];
    const turns = [];
    let remaining = 12_000;
    for (const raw of value.slice(-12)) {
        if (!raw || typeof raw !== "object")
            continue;
        const role = raw.role === "assistant" ? "assistant" : raw.role === "user" ? "user" : null;
        if (!role || remaining <= 0)
            continue;
        const content = String(raw.content ?? "").trim().slice(0, Math.min(4_000, remaining));
        if (!content)
            continue;
        turns.push({ role, content });
        remaining -= content.length;
    }
    return turns;
}
// Commands that set the waiting task aside to come back to later.
export function isConversationParking(value) {
    const normalized = value.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
    const target = "(?:it|that|this(?: task| request| one)?|the task|the request)";
    return new RegExp(`^(?:park(?: ${target})?|hold(?: ${target})?|pause(?: ${target})?|(?:let's )?come back to ${target} later|set ${target} aside|put ${target} on hold|save ${target} for later)$`).test(normalized);
}
export function isConversationCancellation(value) {
    const normalized = value.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
    const target = "(?:it|that|this(?: task| request)?|the task|the request)";
    return new RegExp(`^(?:cancel(?: ${target})?|stop(?: ${target})?|abort(?: ${target})?|never ?mind|forget ${target}|don't do ${target}|do not do ${target})$`).test(normalized);
}
export function canonicalizeVoiceMessage(value) {
    return value.trim().replace(/\bspec\b/gi, "Speck");
}
export async function processNextWorker(runtime, state, archived) {
    if (state.queuePaused || runtime.modelRegistry.list().length === 0)
        return null;
    const worker = queuedWorkers(runtime, archived)[0];
    return worker ? processWorker(runtime, worker, state) : null;
}
export async function processWorker(runtime, input, state) {
    let worker = runtime.getWorker(input.id) ?? input;
    const controller = new SpeckController(runtime, {
        isToolApproved: (name) => {
            const tool = runtime.toolRegistry.list().find((candidate) => candidate.name === name);
            return state.toolApprovals[name] ?? tool?.risk === "read-only";
        },
        getToolAuthorization: (name) => state.toolApprovals[name] === true
            ? { approved: true, approvedBy: "system-capabilities", reason: "Enabled in System → Capabilities" }
            : undefined
    });
    try {
        await controller.run(worker.id);
        worker = runtime.getWorker(worker.id);
        if (worker.coordination && ["completed", "failed", "impasse"].includes(worker.status)) {
            await finalizeSubtask(runtime, worker);
            worker = runtime.getWorker(worker.id);
        }
        return worker;
    }
    catch (error) {
        let current = runtime.getWorker(worker.id);
        if (["orienting", "planning", "executing", "evaluating", "escalating", "learning"].includes(current.status)) {
            current = await runtime.transitionWorker(current.id, "failed", { kind: "runtime", source: "genesis-task-adapter" }, errorMessage(error));
            if (current.coordination)
                await finalizeSubtask(runtime, current);
            return runtime.getWorker(current.id);
        }
        throw error;
    }
}
export async function finalizeSubtask(runtime, worker) {
    const coordination = worker.coordination;
    if (!coordination)
        return;
    const status = worker.status === "completed" ? "completed" : worker.status === "impasse" ? "impasse" : "failed";
    await runtime.reportSubtask({
        workerId: worker.id,
        planId: coordination.planId,
        subtaskId: coordination.subtaskId,
        status,
        summary: resultSummary(worker) || (status === "completed" ? "Subtask completed." : `Subtask ended with status ${status}.`),
        // What the subtask found, not what it was asked: its objective (written
        // by the planner) and the conversation are recorded there as "user
        // message" evidence, and shared back they read as things the user said.
        evidenceIds: worker.evidence.filter((id) => runtime.mentalObjects.get(id)?.data.source !== TASK_EVIDENCE_SOURCE),
        actor: { kind: "worker", source: worker.id, actorId: worker.id }
    });
    const { plan } = runtime.getParallelPlan(coordination.plannerWorkerId, coordination.planId);
    if (plan.subtasks.some((subtask) => !["completed", "failed", "impasse"].includes(subtask.status)))
        return;
    const aggregated = await runtime.aggregateParallelPlan({
        plannerWorkerId: coordination.plannerWorkerId,
        planId: coordination.planId,
        actor: { kind: "runtime", source: "speck-controller:planner" }
    });
    let planner = runtime.getWorker(coordination.plannerWorkerId);
    await runtime.setWorldState({
        workerId: planner.id,
        key: "genesis.resultSummary",
        value: aggregated.result.summary,
        epistemicStatus: "observed",
        confidence: aggregated.result.successful ? 1 : 0.5,
        actor: { kind: "runtime", source: "speck-controller:planner" }
    });
    planner = runtime.getWorker(planner.id);
    if (planner.status === "waiting") {
        planner = await runtime.transitionWorker(planner.id, "evaluating", { kind: "runtime", source: "speck-controller:planner" }, "All planned subtasks reported");
    }
    if (planner.status === "evaluating") {
        await runtime.transitionWorker(planner.id, aggregated.result.successful ? "completed" : "failed", { kind: "runtime", source: "speck-controller:planner" }, "Parallel plan aggregated");
    }
}
export async function transitionToward(runtime, worker, target, reason) {
    if (worker.status === target)
        return worker;
    return runtime.transitionWorker(worker.id, target, { kind: "user", source: "genesis-gui" }, reason);
}
export function queuedWorkers(runtime, archived) {
    return runtime.listWorkers()
        .filter((worker) => !archived.has(worker.id) && ["created", "ready"].includes(worker.status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
export function inProgressWorkers(runtime, archived) {
    return runtime.listWorkers().filter((worker) => !archived.has(worker.id)
        && ["orienting", "planning", "executing", "evaluating", "escalating", "learning"].includes(worker.status));
}
export function requireWorker(runtime, value) {
    const id = parseWorkerId(String(value ?? ""));
    const worker = runtime.getWorker(id);
    if (!worker)
        throw new TypeError(`Task ${id} was not found`);
    return worker;
}
//# sourceMappingURL=tasks.js.map