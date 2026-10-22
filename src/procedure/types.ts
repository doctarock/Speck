import type { MentalObjectId } from "../types/ids.js";
import type { PredictionCondition } from "../prediction/types.js";
import type { ToolIntent } from "../tools/types.js";

export type ProcedureStep =
  | { kind: "tool"; intent: ToolIntent }
  | { kind: "answer"; text: string };

export interface ProcedureDefinition {
  schema: "speck-procedure/v1";
  trigger: { kind: "exact-normalized"; value: string };
  preconditions: PredictionCondition[];
  steps: ProcedureStep[];
  validators: PredictionCondition[];
  failureRoutes: string[];
  status: "candidate" | "compiled" | "deprecated";
  verifiedSuccesses: number;
  creditedEpisodeIds: MentalObjectId[];
  successCount: number;
  failureCount: number;
  utility: number;
  executionHistory: Array<{ executionId: string; successful: boolean; durationMs: number; modelInterventions: number; at: string }>;
}

export interface KnownAnswerDefinition {
  schema: "speck-known-answer/v1";
  keys: string[];
  answer: string;
  sourceObjectId: MentalObjectId;
}
