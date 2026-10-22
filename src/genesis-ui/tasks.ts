// Worker orchestration for the interface (no HTTP): creating and continuing
// conversation workers, running them through the controller, and the queue.

import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { Worker, WorkerStatus } from "../types/model.js";
import { parseWorkerId } from "../types/ids.js";

import { resultSummary, waitingQuestion, errorMessage } from "./presentation.js";
import { GenesisUiState, ConversationTurn } from "./state.js";

export async function createReadyWorker(
  runtime: SpeckRuntime,
  objective: string,
  sessionId: unknown,
  processorId: unknown,
  conversation: ConversationTurn[] = []
): Promise<Worker> {
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
    worker = runtime.getWorker(worker.id)!;
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

export async function recordConversationContinuation(
  runtime: SpeckRuntime,
  worker: Worker,
  answer: string,
  sessionId: unknown
): Promise<void> {
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

export function normalizeConversationTurns(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ConversationTurn[] = [];
  let remaining = 12_000;
  for (const raw of value.slice(-12)) {
    if (!raw || typeof raw !== "object") continue;
    const role = (raw as any).role === "assistant" ? "assistant" : (raw as any).role === "user" ? "user" : null;
    if (!role || remaining <= 0) continue;
    const content = String((raw as any).content ?? "").trim().slice(0, Math.min(4_000, remaining));
    if (!content) continue;
    turns.push({ role, content });
    remaining -= content.length;
  }
  return turns;
}

// Commands that set the waiting task aside to come back to later.
export function isConversationParking(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  const target = "(?:it|that|this(?: task| request| one)?|the task|the request)";
  return new RegExp(`^(?:park(?: ${target})?|hold(?: ${target})?|pause(?: ${target})?|(?:let's )?come back to ${target} later|set ${target} aside|put ${target} on hold|save ${target} for later)$`).test(normalized);
}

export function isConversationCancellation(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  const target = "(?:it|that|this(?: task| request)?|the task|the request)";
  return new RegExp(`^(?:cancel(?: ${target})?|stop(?: ${target})?|abort(?: ${target})?|never ?mind|forget ${target}|don't do ${target}|do not do ${target})$`).test(normalized);
}

export function canonicalizeVoiceMessage(value: string): string {
  return value.trim().replace(/\bspec\b/gi, "Speck");
}

export async function transitionToward(runtime: SpeckRuntime, worker: Worker, target: WorkerStatus, reason: string): Promise<Worker> {
  if (worker.status === target) return worker;
  return runtime.transitionWorker(worker.id, target, { kind: "user", source: "genesis-gui" }, reason);
}

export function queuedWorkers(runtime: SpeckRuntime, archived: Set<string>): Worker[] {
  return runtime.listWorkers()
    .filter((worker) => !archived.has(worker.id) && ["created", "ready"].includes(worker.status))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function inProgressWorkers(runtime: SpeckRuntime, archived: Set<string>): Worker[] {
  return runtime.listWorkers().filter((worker) => !archived.has(worker.id)
    && ["orienting", "planning", "executing", "evaluating", "escalating", "learning"].includes(worker.status));
}

export function requireWorker(runtime: SpeckRuntime, value: unknown): Worker {
  const id = parseWorkerId(String(value ?? ""));
  const worker = runtime.getWorker(id);
  if (!worker) throw new TypeError(`Task ${id} was not found`);
  return worker;
}
