// Applying Speck's rule to the item a message asks about. Once Speck's
// preferred rules agree on an unseen item's label, that label is Speck's
// derivation, not the writer's: the writer is told it, and a reply that gives
// another label first is turned back with the correction.
//
// Found by the integration smoke (2026-10-20): the writer stated Speck's rule
// correctly ("remainder of the number divided by 3: 0 → Ochre") and then
// labelled BX45 Saffron. Applying a stated rule to one item is computation.

import { itemsMentioned } from "./induction.js";
import { preferredPrediction, type InductionStanding } from "./induction-standing.js";

export interface AskedPrediction {
  item: string;
  // The label every preferred rule gives it; null when they disagree or no
  // rule is concluded.
  label: string | null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordAt = (text: string, word: string) => {
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, "iu").exec(text);
  return match ? match.index : -1;
};

// The unseen items a message names, with Speck's prediction for each.
export function askedPredictions(message: string, standing: InductionStanding): AskedPrediction[] {
  const seen = new Set(standing.examples.map((example) => example.item.trim().toUpperCase()));
  return itemsMentioned(message, standing.examples)
    .filter((item) => !seen.has(item.toUpperCase()))
    .map((item) => ({ item, label: preferredPrediction(standing, item) }));
}

export function renderPredictions(predictions: readonly AskedPrediction[]): string {
  if (!predictions.length) return "";
  return `\nSPECK'S PREDICTION FOR THE ITEM${predictions.length > 1 ? "S" : ""} ASKED ABOUT:\n${predictions.map((prediction) => prediction.label
    ? `- ${prediction.item} → ${prediction.label} (every preferred rule gives this label; state it)`
    : `- ${prediction.item}: the preferred rules disagree, so its label cannot be settled from the examples yet`).join("\n")}`;
}

// The first task label in a stretch of text, if any.
const firstLabel = (text: string, labels: readonly string[]) =>
  labels.map((candidate) => ({ candidate, at: wordAt(text, candidate) })).filter((entry) => entry.at >= 0).sort((a, b) => a.at - b.at)[0]?.candidate ?? null;

// For a message asking about one unseen item whose label Speck has settled:
// the label the reply gives the item must be that label. The label a reply
// gives the item is the one following a mention of the item in the same
// sentence ("M52 = Silver", "labelled BX45 Saffron"); a reply that names no
// label beside the item is read by its labels overall. A reply that states
// the rule before answering ("odd → gold, even → silver ... M52: silver") is
// not a fault (default-path run, 2026-10-20: the first-label reading turned
// back two right answers).
export function predictionFaults(reply: string, predictions: readonly AskedPrediction[], labels: readonly string[]): string[] {
  if (predictions.length !== 1 || !predictions[0]!.label) return [];
  const { item, label } = predictions[0]! as { item: string; label: string };
  const same = (candidate: string | null) => candidate !== null && candidate.toUpperCase() === label.toUpperCase();
  const given: string[] = [];
  const mention = new RegExp(`(?<![\\p{L}\\p{N}])${escape(item)}(?![\\p{L}\\p{N}])`, "giu");
  for (const match of reply.matchAll(mention)) {
    const rest = reply.slice(match.index + match[0].length);
    const sentence = rest.slice(0, rest.search(/[.!?\n](\s|$)/u) >= 0 ? rest.search(/[.!?\n](\s|$)/u) : rest.length);
    const beside = firstLabel(sentence, labels);
    if (beside) given.push(beside);
  }
  if (given.some(same)) return [];
  const rival = given[0] ?? (wordAt(reply, label) >= 0 ? null : firstLabel(reply, labels));
  if (!rival && wordAt(reply, label) >= 0) return [];
  return [rival
    ? `Speck's rules give ${item} → ${label}, but your reply gives ${rival}. Give ${item} the label ${label}.`
    : `The user asked for ${item}'s label. Speck's rules give ${item} → ${label}; state it.`];
}
