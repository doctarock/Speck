import { InvalidTransitionError } from "../errors.js";
import type { WorkerStatus } from "../types/model.js";

const TRANSITIONS: Readonly<Record<WorkerStatus, readonly WorkerStatus[]>> = {
  created: ["ready", "impasse", "failed", "suspended"],
  ready: ["orienting", "planning", "executing", "waiting", "impasse", "failed", "suspended"],
  orienting: ["planning", "executing", "waiting", "impasse", "failed", "suspended"],
  planning: ["executing", "waiting", "impasse", "failed", "suspended"],
  executing: ["waiting", "evaluating", "impasse", "completed", "failed", "suspended"],
  waiting: ["ready", "executing", "evaluating", "impasse", "failed", "suspended"],
  evaluating: ["ready", "planning", "executing", "learning", "completed", "failed", "impasse", "suspended"],
  impasse: ["ready", "planning", "escalating", "waiting", "failed", "suspended"],
  escalating: ["planning", "executing", "waiting", "impasse", "failed", "suspended"],
  learning: ["ready", "completed", "failed", "suspended"],
  // A completed task reopens when the user continues its episode, so what it
  // holds (evidence, facts, hypotheses) goes on being revised.
  completed: ["ready"],
  failed: ["ready", "suspended"],
  suspended: ["ready", "failed"]
};

export function allowedTransitions(status: WorkerStatus): readonly WorkerStatus[] {
  return TRANSITIONS[status];
}

export function assertTransition(from: WorkerStatus, to: WorkerStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
}

export const INTERRUPTIBLE_STATUSES: readonly WorkerStatus[] = [
  "orienting", "planning", "executing", "evaluating", "escalating", "learning"
];
