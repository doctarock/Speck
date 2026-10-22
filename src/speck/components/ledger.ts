// The amounts ledger (candidate, 2026-10-21): every number the user states
// in this conversation, with what it counts and whose it is, kept in the
// order told and quoted from the user's own sentence. When a message is about
// something in the ledger, the answering model is shown it, so the first
// value, the latest, and every change in between are in front of it in order.
//
// Built without a language model and without word lists: the structure comes
// from the dependency parse (src/speck/parse.ts): a number is a NUM token;
// what it counts is the noun it modifies (nummod); whose it is, the subject of
// its verb; numbers inside a date or time entity, sentences that are
// questions, and sentences in mapping notation are left out. Speck does not
// decide which way a change goes ("put in" or "used"): the user's sentence
// says it, and the answering model reads it there. (The model-read amounts
// component that tried to decide it failed its gate; failed work/
// components-2026-10-21.)

import type { Component, TurnContext } from "../component.js";
import { componentState } from "../component.js";
import { parseText, sentences, spanText, subtree, type ParsedToken } from "../parse.js";

interface Entry {
  message: number;
  value: string;
  // What it counts ("dollars", "%", "percentage points"), "" when bare.
  counted: string;
  // Whose it is: the subject of its verb, "" when none.
  owner: string;
  sentence: string;
  // Lemmas of the counted noun and owner, to find messages about it.
  words: string[];
}

interface LedgerState { entries: Entry[] }

const MAPPING_NOTATION = /→|->|=>|⇒|=/;
// Entity types whose numbers are not amounts.
const NOT_AMOUNTS = new Set(["DATE", "TIME", "ORDINAL"]);
const CONTENT = new Set(["NOUN", "PROPN"]);

const content = (tokens: readonly ParsedToken[]) => tokens.filter((token) => CONTENT.has(token.pos)).map((token) => token.lemma.toLocaleLowerCase());

// The subject of the clause a token belongs to: up through its heads to the
// first verb, then that verb's subject (or, for a verb joined to another,
// the first one's).
function ownerOf(tokens: readonly ParsedToken[], token: ParsedToken): ParsedToken[] {
  let current: ParsedToken = token;
  for (let steps = 0; steps < 12 && !["VERB", "AUX"].includes(current.pos) && current.head !== current.i; steps += 1) current = tokens[current.head]!;
  for (let steps = 0; steps < 4; steps += 1) {
    const subject = tokens.find((candidate) => candidate.head === current.i && candidate.i !== current.i && /^nsubj/.test(candidate.dep));
    if (subject) return subtree(tokens, subject);
    if (current.dep !== "conj" || current.head === current.i) break;
    current = tokens[current.head]!;
  }
  return [];
}

export function readEntries(text: string, tokens: readonly ParsedToken[], message: number): Entry[] {
  const entries: Entry[] = [];
  for (const sentence of sentences(tokens)) {
    const said = spanText(text, sentence).trim();
    if (!said || said.endsWith("?") || MAPPING_NOTATION.test(said)) continue;
    for (const token of sentence) {
      if (token.pos !== "NUM" || NOT_AMOUNTS.has(token.ent) || !/\d/.test(token.text)) continue;
      const counted = token.dep === "nummod" ? tokens[token.head]! : null;
      const countedTokens = counted ? [...sentence.filter((other) => other.head === counted.i && other.dep === "compound"), counted] : [];
      const owner = ownerOf(tokens, counted ?? token);
      entries.push({
        message, value: token.text, counted: countedTokens.map((other) => other.text).join(" "),
        owner: spanText(text, owner), sentence: said,
        words: [...new Set([...content(countedTokens), ...content(owner)])]
      });
    }
  }
  return entries;
}

function render(entries: readonly Entry[]): string {
  return ["Numbers the user has stated in this conversation, in the order told (Speck's ledger, quoted from the user's own sentences; work from these, in this order):",
    ...entries.map((entry, index) => `${index + 1}. message ${entry.message}: ${entry.value}${entry.counted ? ` ${entry.counted}` : ""}${entry.owner ? ` (${entry.owner})` : ""} — "${entry.sentence}"`)].join("\n");
}

export const ledger: Component = {
  id: "ledger",

  async observe(context: TurnContext) {
    const state = componentState<LedgerState>(context.session, "ledger", () => ({ entries: [] }));
    const needed = /\d/.test(context.message) || state.entries.length > 0;
    const tokens = needed ? await parseText(context.message) : null;
    context.scratch.set("ledger.tokens", tokens);
    if (!tokens || !/\d/.test(context.message)) return;
    const added = readEntries(context.message, tokens, context.turn + 1);
    state.entries.push(...added);
    context.scratch.set("ledger.added", added.length);
  },

  async contribute(context: TurnContext) {
    const state = componentState<LedgerState>(context.session, "ledger", () => ({ entries: [] }));
    const tokens = context.scratch.get("ledger.tokens") as ParsedToken[] | null | undefined;
    if (!tokens || !state.entries.length) return null;
    // About the ledger: the message names what a number counts or whose it
    // is, or it is a question right after a message that added to it ("How
    // much is in it now?").
    const named = new Set(content(tokens));
    const previous = context.turn;
    const follows = context.message.trim().endsWith("?") && state.entries.some((entry) => entry.message === previous);
    const about = follows || state.entries.some((entry) => entry.words.some((word) => named.has(word)));
    context.scratch.set("ledger.shown", about);
    return about ? render(state.entries) : null;
  },

  record(context: TurnContext) {
    return { added: context.scratch.get("ledger.added") ?? 0, shown: context.scratch.get("ledger.shown") ?? false };
  }
};
