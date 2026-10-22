// How Speck's workers, models and settings are presented to the Genesis interface.

import fs from "node:fs/promises";
import { buildPublicProfile, getActiveProfileSelection, listAvailableProfiles } from "genesis-runtime/profile-manager";
import { judgmentOnly } from "../models/types.js";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { CognitiveEvent, Worker, WorkerStatus } from "../types/model.js";

import { GenesisUiState } from "./state.js";

export function runtimeOptions(runtime: SpeckRuntime, profile: Record<string, any>, state: GenesisUiState) {
  const brains = runtime.modelRegistry.list().map(toGenesisBrain);
  return {
    ok: true,
    app: appConfig(state),
    profile: buildPublicProfile(profile),
    language: { locale: "en-AU" },
    lexicon: {},
    defaults: { intakeBrainId: runtime.modelRegistry.generative()[0]?.id ?? "worker" },
    queue: { paused: state.queuePaused, remoteParallel: false, escalationEnabled: runtime.config.modelEscalation.enabled },
    projects: [], routing: { enabled: true, specialistMap: {} }, networks: [], mail: { configured: false },
    brains, brainEndpoints: [], mounts: []
  };
}

export function appConfig(state: GenesisUiState): Record<string, unknown> {
  return {
    botName: "Speck",
    identityName: "Speck",
    trust: { voiceProfiles: [], voiceCommandMinLevel: "trusted", records: [] },
    voicePreferences: [],
    ...state.app
  };
}

export function brainConfig(runtime: SpeckRuntime) {
  const models = runtime.modelRegistry.list();
  return {
    ok: true,
    brains: {
      enabledIds: models.filter((model) => model.enabled).map((model) => model.id),
      endpoints: {}, assignments: {}, custom: [], builtIn: models.map(toGenesisBrain),
      processors: runtime.config.modelRuntime.processors.map((processor) => ({ ...processor })),
      roles: structuredClone(runtime.config.modelRuntime.roles),
      embedding: structuredClone(runtime.config.embeddingRuntime),
      // Each processor's measured qualification per judgment class, and who
      // would check the writer's claims now (none: every check is void).
      qualifications: Object.fromEntries(models.map((model) => [model.id, qualificationSummary(runtime, model.id)])),
      checker: {
        configured: runtime.config.modelRuntime.roles.checker ?? "",
        effective: runtime.qualifiedProcessor(runtime.processorForRole("writer"), "atomic-entailment") ?? ""
      }
    },
    routing: { enabled: true, specialistMap: {}, fallbackAttempts: runtime.config.modelRuntime.maxAttempts },
    queue: { remoteParallel: false, escalationEnabled: runtime.config.modelEscalation.enabled }
  };
}

export function toolConfig(runtime: SpeckRuntime, state: GenesisUiState) {
  return {
    ok: true,
    tools: runtime.toolRegistry.list().map((tool) => ({
      ...tool,
      approved: state.toolApprovals[tool.name] ?? tool.risk === "read-only",
      defaultApproved: tool.risk === "read-only"
    })),
    installedSkills: [], toolRequests: [], skillRequests: []
  };
}

// A processor's atomic-entailment qualification as the interface shows it.
function qualificationSummary(runtime: SpeckRuntime, processorId: string) {
  const measured = runtime.processorCompetence.qualification(runtime.modelRegistry.modelKey(processorId), "atomic-entailment");
  if (!measured) return { atomicEntailment: null };
  const rate = (tally: { correct: number; total: number }) => tally.total ? tally.correct / tally.total : 0;
  return {
    atomicEntailment: {
      qualified: measured.qualified, corpus: measured.corpus, measuredAt: measured.measuredAt,
      contradiction: rate(measured.byLabel.contradiction), negationConsistency: rate(measured.negationConsistency), overall: rate(measured.overall),
      lowerBounds: measured.lowerBounds, thresholds: measured.thresholds
    }
  };
}

export function toGenesisBrain(model: any) {
  const checker = judgmentOnly(model);
  return {
    id: model.id, label: model.id, kind: checker ? "checker" : model.tier === 1 ? "intake" : "worker", model: model.model,
    provider: model.provider, endpointId: "local", endpointLabel: "Local", baseUrl: "", remote: false,
    queueLane: `tier-${model.tier}`, specialty: model.specialties?.[0] ?? "general",
    toolCapable: !checker, cronCapable: !checker,
    description: checker ? "Judgment-only checker (atomic entailment)" : `Speck tier ${model.tier} processor`
  };
}

export function toGenesisTask(worker: Worker) {
  const status = genesisTaskStatus(worker.status);
  const updatedAt = Date.parse(worker.updatedAt);
  const createdAt = Date.parse(worker.createdAt);
  const summary = resultSummary(worker);
  return {
    id: worker.id,
    codename: `TASK-${worker.id.slice(-8).toUpperCase()}`,
    message: worker.objective.description,
    objective: worker.objective.description,
    status,
    sessionId: "Main",
    requestedBrainId: worker.modelAssignment?.processorId ?? "worker",
    requestedBrainLabel: worker.modelAssignment?.processorId ?? "Speck Worker",
    model: worker.modelAssignment?.processorId ?? "",
    createdAt,
    updatedAt,
    completedAt: status === "completed" || status === "failed" ? updatedAt : null,
    startedAt: worker.progress.cycle > 0 || status === "in_progress" ? updatedAt : null,
    attempts: worker.progress.cycle,
    progressNote: status === "in_progress" ? `Speck cycle ${worker.progress.cycle}` : "",
    resultSummary: summary,
    workerSummary: summary,
    questionForUser: status === "waiting_for_user" ? waitingQuestion(worker) : "",
    // A parked task waits to be resumed; its thread comes back with it.
    parked: Boolean(worker.worldState["genesis.parked"]?.value),
    conversation: status === "waiting_for_user" && Array.isArray(worker.worldState["genesis.conversationTurns"]?.value) ? worker.worldState["genesis.conversationTurns"]!.value : [],
    meta: { speckWorkerId: worker.id, revision: worker.revision, confidence: worker.confidence }
  };
}

export function genesisTaskStatus(status: WorkerStatus): string {
  if (["created", "ready", "orienting", "planning"].includes(status)) return "queued";
  if (["executing", "evaluating", "escalating", "learning"].includes(status)) return "in_progress";
  if (["waiting", "impasse"].includes(status)) return "waiting_for_user";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "closed";
}

export function resultSummary(worker: Worker): string {
  const value = worker.worldState["genesis.resultSummary"]?.value;
  return typeof value === "string" ? value : "";
}

// The reply a processed task gives the user, chosen by its status. A
// waiting task's reply is its question; its result summary may be the answer
// to an earlier message of the same task (four-arm trace and smoke-d,
// 2026-10-20: after "12 + 12 = 24" completed a turn, every later reply of
// the reopened task repeated it). Failure is handled by the caller.
export function replyFor(worker: Worker): string {
  if (worker.status === "waiting") return waitingQuestion(worker);
  return resultSummary(worker);
}

export function waitingQuestion(worker: Worker): string {
  const value = worker.worldState["genesis.questionForUser"]?.value;
  return typeof value === "string" && value.trim() ? value : `What additional direction is needed for: ${worker.objective.description}`;
}

// "clear": the interface should start a fresh conversation thread (after a
// cancel, or once the task has been parked with its own thread).
export function agentResponse(worker: Worker, text: string, durationMs: number, thread?: "clear") {
  const status = worker.status === "completed" ? "completed"
    : worker.status === "failed" ? "failed"
      : worker.status === "waiting" || worker.status === "impasse" ? "waiting_for_user" : "in_progress";
  return {
    ok: true,
    parsed: { status, result: { payloads: [{ text }], meta: { durationMs } } },
    brain: { id: worker.modelAssignment?.processorId ?? "worker", label: worker.modelAssignment?.processorId ?? "Speck Worker", model: worker.modelAssignment?.processorId ?? "" },
    network: "speck",
    attachments: [], outputFiles: [], tasks: [], task: toGenesisTask(worker),
    ...(thread ? { thread } : {})
  };
}

// A reply on Speck's default path (src/speck/respond.ts), in the shape the
// interface reads: no task stands behind it.
export function chatResponse(text: string, durationMs: number, path: string, thread?: "clear") {
  return {
    ok: true,
    parsed: { status: "completed", result: { payloads: [{ text }], meta: { durationMs, path } } },
    brain: { id: "speck", label: "Speck", model: "" },
    network: "speck",
    attachments: [], outputFiles: [], tasks: [], task: null,
    ...(thread ? { thread } : {})
  };
}

export function toGenesisHistoryEvent(event: CognitiveEvent<unknown>) {
  return {
    eventSeq: event.sequence, type: genesisEventType(event.type), eventType: event.type,
    createdAt: Date.parse(event.occurredAt), ts: Date.parse(event.occurredAt), reason: JSON.stringify(event.payload),
    payload: event.payload
  };
}

export function genesisEventType(type: string): string {
  if (type === "worker.created") return "task.created";
  if (type === "worker.recovered") return "task.recovered";
  if (type === "model-completed") return "task.progress";
  if (type === "worker.transitioned") return "task.updated";
  return `speck.${type}`;
}

export async function profilePayload(profile: Record<string, any>, profileRoot: string) {
  return {
    ok: true,
    profile: buildPublicProfile(profile),
    profiles: await listAvailableProfiles({ fs, rootDir: profileRoot }),
    selection: getActiveProfileSelection(),
    restart: { supported: false, required: Boolean(getActiveProfileSelection().pendingProfileId) }
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function latestWorkerFailureReason(runtime: SpeckRuntime, worker: Worker): string {
  const event = runtime.listEvents(worker.id, 0, 1_000).reverse().find((candidate) => {
    if (candidate.type !== "worker.transitioned") return false;
    const payload = candidate.payload as Record<string, unknown>;
    return payload.to === "failed" && typeof payload.reason === "string";
  });
  return event ? String((event.payload as Record<string, unknown>).reason ?? "").trim() : "";
}

export function failureResponse(runtime: SpeckRuntime, worker: Worker): string {
  const reason = latestWorkerFailureReason(runtime, worker);
  return reason ? `I could not complete that request: ${reason}` : "I could not complete that request, and no specific failure reason was recorded.";
}
