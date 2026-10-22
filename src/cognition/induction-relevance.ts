// Whether a message is about a task's induction. A task that is learning a
// rule from labelled examples may receive messages that have nothing to do
// with it ("Quick one: what is 6 plus 12?"). For such a message the rule
// state is not shown to the writer, does not force the reply to be
// provisional, is not checked against the reply, and Speck adds no
// statement of the rule; the message is answered as itself.
//
// The test is structural, with no word lists. A message is about the
// induction if it gives examples, or names one of the task's items or labels.
// Otherwise it is about the induction unless it brings operands of its own:
// numbers that are not the task's items. A question about the rule ("What
// rule decides the label?") therefore keeps the rule state, and arithmetic
// asked between examples does not.
//
// Found in the four-arm evaluation (2026-10-19): 28 of full Speck's losses
// were arithmetic questions asked between examples and answered with the
// rule report instead of the sum.

import { itemsMentioned, type LabelledExample } from "./induction.js";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function concernsInduction(message: string, examples: readonly LabelledExample[], statedExamplesInMessage: number): boolean {
  if (statedExamplesInMessage > 0) return true;
  const items = itemsMentioned(message, examples);
  if (items.length > 0) return true;
  const labels = [...new Set(examples.map((example) => example.label.trim()).filter(Boolean))];
  if (labels.some((label) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(label)}(?![\\p{L}\\p{N}])`, "iu").test(message))) return true;
  // Numbers of its own: what remains after the task's item-shaped tokens are removed.
  return !/\d/.test(message);
}
