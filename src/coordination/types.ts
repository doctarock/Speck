import type { MentalObjectId, WorkerId } from "../types/ids.js";

export const WORKER_MESSAGE_TYPES = [
  "request-evidence", "request-analysis", "request-tool-action", "report-finding",
  "report-failure", "report-impasse", "report-completion"
] as const;
export type WorkerMessageType = (typeof WORKER_MESSAGE_TYPES)[number];

export type SubtaskStatus = "blocked" | "ready" | "running" | "completed" | "failed" | "impasse";

export interface SubtaskSpec {
  id: string;
  objective: string;
  dependencies: string[];
  priority: number;
  completionCriteria: string[];
  constraints: string[];
}

export interface PlannedSubtask extends SubtaskSpec {
  workerId: WorkerId;
  status: SubtaskStatus;
  summary: string | null;
  evidenceIds: MentalObjectId[];
  completedAt: string | null;
}

export interface ParallelPlanDefinition {
  schema: "speck.parallel-plan.v1";
  plannerWorkerId: WorkerId;
  objective: string;
  status: "active" | "completed" | "failed";
  subtasks: PlannedSubtask[];
  createdAt: string;
  completedAt: string | null;
}

export interface WorkerMessageDefinition {
  schema: "speck.worker-message.v1";
  type: WorkerMessageType;
  senderWorkerId: WorkerId;
  recipientWorkerId: WorkerId;
  planId: MentalObjectId;
  subtaskId: string | null;
  payload: Record<string, unknown>;
  sentAt: string;
}

export interface AggregatedPlanResult {
  planId: MentalObjectId;
  objective: string;
  successful: boolean;
  summary: string;
  subtaskResults: Array<{
    subtaskId: string;
    workerId: WorkerId;
    status: SubtaskStatus;
    summary: string | null;
    evidenceIds: MentalObjectId[];
  }>;
  evidenceIds: MentalObjectId[];
}
