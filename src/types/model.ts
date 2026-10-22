import type { CognitiveEventId, MentalObjectId, WorkerId } from "./ids.js";
import type { CalibrationProfile, MetacognitiveState } from "../metacognition/types.js";

export const WORKER_STATUSES = [
  "created", "ready", "orienting", "planning", "executing", "waiting", "evaluating",
  "impasse", "escalating", "learning", "completed", "failed", "suspended"
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const MENTAL_OBJECT_KINDS = [
  "observation", "fact", "belief", "hypothesis", "question", "goal", "commitment",
  "prediction", "evidence", "tool-outcome", "reflection", "procedure", "known-answer",
  "strategy", "constraint", "error", "impasse", "artifact"
] as const;
export type MentalObjectKind = (typeof MENTAL_OBJECT_KINDS)[number];

export type ProvenanceKind = "user" | "runtime" | "tool" | "model" | "worker" | "external" | "recovery";

export interface Provenance {
  kind: ProvenanceKind;
  source: string;
  actorId: string | null;
  eventId: CognitiveEventId | null;
  correlationId: string | null;
  recordedAt: string;
}

export interface ActivationState {
  baseLevel: number;
  spreading: number;
  noise: number;
  suppression: number;
  total: number;
  decay: number;
  references: string[];
  lastComputedAt: string;
}

export const EDGE_KINDS = [
  "associative", "causal", "subgoal-of", "derived-from", "contradicts", "supports", "inhibitory"
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface AssociativeEdge {
  targetId: MentalObjectId;
  kind: EdgeKind;
  strength: number;
  lastCoactivatedAt: string;
}

export interface WorkspaceState {
  attentionScore: number | null;
  inWorkingMemory: boolean;
  broadcastCount: number;
  lastBroadcastAt: string | null;
}

export interface MentalObject {
  id: MentalObjectId;
  workerId: WorkerId | null;
  kind: MentalObjectKind;
  content: string;
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  memoryRoles: Array<"working" | "episodic" | "semantic" | "procedural" | "evidence" | "known-answer">;
  activation: ActivationState;
  associations: AssociativeEdge[];
  workspace: WorkspaceState;
  provenance: Provenance;
  status: "active" | "dormant" | "superseded" | "rejected" | "archived";
  createdAt: string;
  lastAccessedAt: string;
}

export type EpistemicStatus = "observed" | "inferred" | "assumed" | "unknown";

export interface WorldStateEntry {
  key: string;
  value: unknown;
  epistemicStatus: EpistemicStatus;
  confidence: number;
  provenance: Provenance;
  observedAt: string;
  updatedAt: string;
}

export interface Worker {
  id: WorkerId;
  objective: { description: string; constraints: string[] };
  status: WorkerStatus;
  workingMemory: MentalObjectId[];
  commitments: MentalObjectId[];
  beliefs: MentalObjectId[];
  hypotheses: MentalObjectId[];
  evidence: MentalObjectId[];
  worldState: Record<string, WorldStateEntry>;
  currentStrategy: MentalObjectId | null;
  currentProcedure: MentalObjectId | null;
  modelAssignment: { processorId: string; tier: number } | null;
  progress: { cycle: number; lastProgressAt: string | null; score: number };
  confidence: { overall: number; calibrated: number | null; calibration?: Record<string, CalibrationProfile> };
  operationalState: { mode: "normal" | "focused" | "exploratory" | "conservative"; pressure: number };
  openQuestions: MentalObjectId[];
  impasses: MentalObjectId[];
  metacognition?: MetacognitiveState;
  coordination?: {
    rootWorkerId: WorkerId;
    plannerWorkerId: WorkerId;
    planId: MentalObjectId;
    subtaskId: string;
  } | null;
  recovery: { interruptedFrom: WorkerStatus | null; recoveredAt: string | null };
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type CognitiveEventType =
  | "worker.created" | "worker.transitioned" | "worker.recovered"
  | "mental-object.created" | "observation" | "tool-result" | "memory-activation"
  | "impasse-detected" | "model-completed" | "procedure-result"
  | "belief-changed" | "commitment-changed"
  | "working-memory.admitted" | "memory.recorded" | "commitment.created"
  | "world-state.changed" | "evidence.recorded" | "evidence.withdrawn" | "hypothesis.proposed" | "hypothesis.restated"
  | "worker.cycle-completed" | "memory.referenced" | "association.reinforced"
  | "working-memory.competed" | "model.assigned"
  | "tool.execution-started" | "tool.execution-completed" | "tool.execution-recovered"
  | "prediction.created" | "prediction.compared" | "belief.revised"
  | "confidence.calibrated" | "metacognition.assessed" | "impasse.resolved"
  | "model.escalated" | "model.deescalated" | "model.escalation-deferred"
  | "procedure.candidate" | "procedure.compiled" | "procedure.executed" | "procedure.feedback"
  | "known-answer.recorded" | "known-answer.hit"
  | "shared-memory.archived"
  | "plan.created" | "subtask.assigned" | "worker.message-sent" | "evidence.shared"
  | "subtask.reported" | "dependency.resolved" | "plan.aggregated"
  | "background.maintenance";

export interface MemoryRetrievalCandidate {
  object: MentalObject;
  activation: number;
}

export interface MemoryRetrievalResult {
  workerId: WorkerId;
  anchorIds: MentalObjectId[];
  candidates: MemoryRetrievalCandidate[];
  computedAt: string;
}

export interface CognitiveEvent<T = Record<string, unknown>> {
  id: CognitiveEventId;
  sequence: number;
  workerId: WorkerId | null;
  type: CognitiveEventType;
  payload: T;
  provenance: Provenance;
  causationId: CognitiveEventId | null;
  correlationId: string;
  occurredAt: string;
}

export interface NewCognitiveEvent<T = Record<string, unknown>> {
  id: CognitiveEventId;
  workerId: WorkerId | null;
  type: CognitiveEventType;
  payload: T;
  provenance: Provenance;
  causationId: CognitiveEventId | null;
  correlationId: string;
  occurredAt: string;
}
