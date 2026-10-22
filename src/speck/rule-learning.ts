// A conversation's rule learning: the labelled examples it has been given
// (read structurally, src/speck/examples.ts), and what Speck's deterministic
// derivation concludes from them. This is the component with measured gain:
// given correct examples, Speck's derivation raised unseen rule-task answers
// from 85.6% to 100% (four-arm evaluation, C+ against C, 2026-10-19).
//
// The derivation itself is unchanged (src/cognition/induction*.ts). The state
// is plain data, so it persists with the session as JSON.

import type { RejectedCandidate, SupportedExample } from "../cognition/example-support.js";
import { isInductionItem, survivingRules, type LabelledExample } from "../cognition/induction.js";
import { learnable, standingOf, type InductionStanding } from "../cognition/induction-standing.js";
import { renderInductionReport } from "../cognition/induction-render.js";
import { concernsInduction } from "../cognition/induction-relevance.js";
import { askedPredictions, renderPredictions, type AskedPrediction } from "../cognition/induction-answer.js";

export interface RuleLearningState {
  examples: LabelledExample[];
  // Pairs the reader proposed that the message did not write as examples.
  rejected: Array<RejectedCandidate & { turn: number }>;
  // Items given two labels: withdrawn, never silently resolved.
  conflicts: Array<{ item: string; labels: string[]; turns: number[] }>;
}

export const emptyRuleLearning = (): RuleLearningState => ({ examples: [], rejected: [], conflicts: [] });

const evidenceId = (turn: number) => `turn-${turn}`;

// Adds the examples a message wrote; returns how many it added.
export function addExamples(state: RuleLearningState, turn: number, accepted: readonly SupportedExample[], rejected: readonly RejectedCandidate[]): number {
  state.rejected.push(...rejected.map((entry) => ({ ...entry, turn })));
  let added = 0;
  for (const pair of accepted.filter((entry) => isInductionItem(entry.item))) {
    const key = pair.item.toUpperCase();
    const conflict = state.conflicts.find((entry) => entry.item.toUpperCase() === key);
    const known = state.examples.find((entry) => entry.item.toUpperCase() === key);
    if (conflict) {
      if (!conflict.labels.some((label) => label.toUpperCase() === pair.label.toUpperCase())) conflict.labels.push(pair.label);
      conflict.turns.push(turn);
    } else if (known && known.label.toUpperCase() !== pair.label.toUpperCase()) {
      state.examples = state.examples.filter((entry) => entry !== known);
      state.conflicts.push({ item: known.item, labels: [known.label, pair.label], turns: [Number(known.evidenceId.slice(5)), turn] });
    } else if (!known) {
      state.examples.push({ item: pair.item, label: pair.label, evidenceId: evidenceId(turn) });
      added += 1;
    }
  }
  return added;
}

export function standing(state: RuleLearningState): InductionStanding | null {
  if (!learnable(state.examples)) return null;
  return standingOf(state.examples, survivingRules(state.examples).map((entry) => ({ rule: entry.rule, confidence: 0.5 })));
}

// What Speck adds for a message about its rule learning: null when it has
// nothing (too few examples) or the message is not about it.
export function contribution(state: RuleLearningState, message: string, turn: number): { notes: string; predictions: AskedPrediction[]; standing: InductionStanding } | null {
  const current = standing(state);
  if (!current) return null;
  const statedHere = state.examples.filter((example) => example.evidenceId === evidenceId(turn)).length;
  if (!concernsInduction(message, state.examples, statedHere)) return null;
  const predictions = askedPredictions(message, current);
  const notes = [
    "NOTES ON THIS CONVERSATION (kept outside the model)",
    "",
    "Labelled examples given so far:",
    ...state.examples.map((example) => `- ${example.item} → ${example.label} (message ${Number(example.evidenceId.slice(5)) + 1})`),
    "",
    "Derived from them:",
    `${renderInductionReport(current, evidenceId(turn))}${renderPredictions(predictions)}`
  ].join("\n");
  return { notes, predictions, standing: current };
}
