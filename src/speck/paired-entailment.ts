// The paired judgment at runtime (2026-10-22): a checker is asked whether a
// premise establishes a proposition and whether it establishes the
// proposition's opposite, which Speck forms from the parse
// (src/speck/negation.ts, "verb-or-wrapper", the form the qualification is
// bound to). A verdict is returned only when the two answers are opposed as
// labels are; otherwise the judgment is void, and nothing may be concluded
// from it. With no parse, the opposite cannot be formed as qualified: void.

import { opposed, PAIRED_OPPOSITE_FORM, type EntailmentLabel } from "../metacognition/qualification.js";
import { oppositeOf } from "./negation.js";
import { parseText, type ParsedToken } from "./parse.js";

export type Ask = (premise: string, hypothesis: string) => Promise<EntailmentLabel | null>;

export interface PairedVerdict {
  // The verdict on the proposition, or null when the judgment is void.
  label: EntailmentLabel | null;
  opposite: string | null;
  answers: { proposition: EntailmentLabel | null; opposite: EntailmentLabel | null };
}

export async function pairedEntailment(ask: Ask, premise: string, proposition: string, parse: (text: string) => Promise<ParsedToken[] | null> = parseText): Promise<PairedVerdict> {
  const tokens = await parse(proposition);
  if (!tokens) return { label: null, opposite: null, answers: { proposition: null, opposite: null } };
  const opposite = oppositeOf(proposition, tokens, PAIRED_OPPOSITE_FORM);
  const answers = { proposition: await ask(premise, proposition), opposite: await ask(premise, opposite) };
  const committed = answers.proposition !== null && answers.opposite === opposed(answers.proposition);
  return { label: committed ? answers.proposition : null, opposite, answers };
}
