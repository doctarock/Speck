import type { MentalObjectId } from "../types/ids.js";

export const HYPOTHESIS_STATUSES = [
  "proposed", "active", "supported", "weakening", "rejected", "confirmed", "superseded"
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export interface EvidenceRelation {
  hypothesisId: MentalObjectId;
  direction: "supports" | "contradicts";
  strength?: number;
  // A deterministic counter-example: an observation the hypothesis cannot
  // accommodate, checked by Speck rather than judged by a model. It refutes
  // the hypothesis outright instead of lowering its confidence a step.
  decisive?: boolean;
}

export interface BeliefRevisionEntry {
  evidenceId: MentalObjectId;
  direction: EvidenceRelation["direction"];
  reliability: number;
  strength: number;
  delta: number;
  previousConfidence: number;
  newConfidence: number;
  previousStatus: HypothesisStatus;
  newStatus: HypothesisStatus;
  source: string;
  at: string;
}
