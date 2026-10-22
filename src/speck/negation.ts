// The opposite of a proposition, formed by Speck from its dependency parse
// (2026-10-22), so a checker can be asked about a requirement and its
// opposite (the paired judgment; docs/experiments/qualification/README.md)
// without a model writing the opposite.
//
// Two forms, measured against hand-written opposites:
//   "verb":    the clause's own negation. A negated clause loses its negation
//              ("did not pass" → "did pass", "has never been" → "has been",
//              "no longer sells" → "sells"); otherwise "not" follows the first
//              auxiliary ("was closed" → "was not closed") or the copula
//              ("is empty" → "is not empty"), and a bare verb takes do-support
//              in its tense ("left" → "did not leave", "sells" → "does not
//              sell").
//   "wrapper": "It is not true that P." The exact contradictory, with no
//              grammar; the question is how a checker reads it.
// The words this writes ("not", "do", "it is not true that") are the grammar
// of an English negation being produced, not a list Speck recognises text by.

import type { ParsedToken } from "./parse.js";

export type NegationForm = "verb" | "wrapper" | "verb-or-wrapper";

const render = (tokens: readonly ParsedToken[], replace: ReadonlyMap<number, string>, drop: ReadonlySet<number>) =>
  tokens.filter((token) => !drop.has(token.i))
    .map((token, index, kept) => `${replace.get(token.i) ?? token.text}${index < kept.length - 1 ? (token.ws ?? " ") : ""}`)
    .join("").replace(/\s+([.,!?;:])/g, "$1").replace(/\s{2,}/g, " ").trim();

export function wrapperOpposite(text: string): string {
  const clause = text.trim().replace(/[.!]+$/, "");
  return `It is not true that ${clause.charAt(0).toLocaleLowerCase()}${clause.slice(1)}.`;
}

// The verb form; null when the parse has no clause root to negate.
export function verbOpposite(tokens: readonly ParsedToken[]): string | null {
  const root = tokens.find((token) => token.dep === "ROOT");
  if (!root) return null;
  const children = (head: ParsedToken) => tokens.filter((token) => token.head === head.i && token.i !== head.i);
  const replace = new Map<number, string>();
  const drop = new Set<number>();
  // Already negated: remove the negation (with an adverb it qualifies, as in
  // "no longer"), keeping any do-support as emphasis ("did pass").
  const negations = tokens.filter((token) => token.dep === "neg" && (token.head === root.i || tokens[token.head]?.head === root.i));
  if (negations.length) {
    for (const negation of negations) {
      drop.add(negation.i);
      const head = tokens[negation.head]!;
      if (head.i !== root.i && head.dep === "advmod") drop.add(head.i);
    }
    return render(tokens, replace, drop);
  }
  const auxiliary = children(root).filter((token) => token.dep === "aux" || token.dep === "auxpass").sort((a, b) => a.i - b.i)[0];
  if (auxiliary) {
    replace.set(auxiliary.i, `${auxiliary.text} not`);
  } else if (root.pos === "AUX" || root.lemma === "be") {
    replace.set(root.i, `${root.text} not`);
  } else if (root.pos === "VERB") {
    const support = root.tag === "VBD" || root.tag === "VBN" ? "did" : root.tag === "VBZ" ? "does" : "do";
    // A verb written with a prefix the parse splits off ("co-wrote") keeps it:
    // the support goes before the whole word ("did not co-write").
    let start = root.i;
    while (start > 0 && tokens[start - 1]!.ws === "" && tokens[start - 1]!.pos !== "PUNCT" || (start > 0 && tokens[start - 1]!.text === "-" && tokens[start - 1]!.ws === "")) start -= 1;
    const prefix = tokens.slice(start, root.i).map((token) => token.text).join("");
    for (let index = start; index < root.i; index += 1) drop.add(index);
    replace.set(root.i, `${support} not ${prefix}${root.lemma}`);
  } else {
    return null;
  }
  return render(tokens, replace, drop);
}

// Whether the clause's subject is quantified ("Every guest", "No virus",
// "Nobody", "Most of the lights", "Two of the printers"), where negating the
// verb is not the opposite ("Every guest had not left"). Read from the parse:
// a subject with a determiner that is not an article, a subject marked as
// indefinite, cardinal or superlative, a determiner standing as the subject,
// or a subject with a partitive "… of the Ys" child. An existential ("There
// was nothing …") is judged by what it introduces.
export function quantifiedSubject(tokens: readonly ParsedToken[]): boolean {
  const root = tokens.find((token) => token.dep === "ROOT");
  if (!root) return false;
  const children = (head: ParsedToken) => tokens.filter((token) => token.head === head.i && token.i !== head.i);
  let subject = children(root).find((token) => /^nsubj/.test(token.dep) || token.dep === "expl");
  if (subject?.dep === "expl") subject = children(root).find((token) => token.dep === "attr");
  if (!subject) return false;
  if (/PronType=Ind|NumType=Card|Degree=Sup/.test(subject.morph) || subject.tag === "DT") return true;
  if (children(subject).some((child) => child.dep === "det" && !/PronType=Art/.test(child.morph))) return true;
  return children(subject).some((child) => child.dep === "prep" && children(child).some((object) => object.dep === "pobj"));
}

export function oppositeOf(text: string, tokens: readonly ParsedToken[] | null, form: NegationForm): string {
  if (form === "wrapper" || !tokens) return wrapperOpposite(text);
  if (form === "verb-or-wrapper" && quantifiedSubject(tokens)) return wrapperOpposite(text);
  return verbOpposite(tokens) ?? wrapperOpposite(text);
}
