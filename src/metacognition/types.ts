import type { MentalObjectId } from "../types/ids.js";

export type ImpasseReason =
  | "loop-detected"
  | "progress-stagnation"
  | "repeated-failure"
  | "confidence-stagnation"
  | "no-new-evidence"
  | "no-valid-action"
  | "conflicting-evidence"
  | "hypotheses-exhausted"
  | "confidence-too-low"
  | "strategy-exhausted"
  | "required-resource-unavailable"
  | "procedure-invalid"
  | "world-model-insufficient";

export type ImpasseResponse =
  | "retrieve-additional-memories"
  | "expand-spreading-activation"
  | "spawn-subgoal"
  | "change-strategy"
  | "request-planner-intervention"
  | "request-another-worker"
  | "increase-model-tier"
  | "request-human-input"
  | "wait-for-dependency";

export interface CalibrationSample {
  reportedConfidence: number;
  reward: number;
  bias: number;
  sourceObjectId: MentalObjectId | null;
  recordedAt: string;
}

export interface CalibrationProfile {
  processorId: string;
  samples: CalibrationSample[];
  bias: number;
  meanAbsoluteError: number;
  reliability: number;
  updatedAt: string;
}

export interface CognitiveCycleSample {
  cycle: number;
  signature: string;
  madeProgress: boolean;
  score: number;
  evidenceCount: number;
  hypothesisConfidence: number | null;
  action: string | null;
  error: string | null;
  recordedAt: string;
}

export interface MetacognitiveState {
  cyclesWithoutProgress: number;
  repeatedStateCount: number;
  lastSignature: string | null;
  cycleHistory: CognitiveCycleSample[];
  activeImpasseId: MentalObjectId | null;
  lastAssessmentAt: string | null;
}

export interface CycleAssessment {
  signature: string;
  cyclesWithoutProgress: number;
  repeatedStateCount: number;
  reasons: ImpasseReason[];
  responses: ImpasseResponse[];
  signals: Record<string, unknown>;
}
