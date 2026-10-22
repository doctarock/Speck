// Whether a message explicitly states each labelled example a model read in
// it. A candidate pair becomes a trusted example only when a sentence (or
// line) of the message writes it in explicit mapping notation: the item, a
// mapping symbol (→, ->, =>, ⇒, :, =), then the label. The sentence must not
// be a question, and the pair must not be inside quotation marks. Otherwise
// the pair is rejected, with the reason, and Speck abstains rather than
// invent it. The check is structural: it uses no word lists.
//
// Found on the four-arm evaluation (2026-10-19): the reader's only check was
// that the item and the label each occur somewhere in the message, so "What
// label does Z20 get?" became the example Z20 → label, and "What label does
// T98 get?" became T98 → T98. One such pair destroys the derivation.
//
// Examples given in prose ("H46 is Sand") are not accepted: telling a prose
// statement from a negated, hypothetical or reported one needs word lists or
// a parse, which this check deliberately does without.

export interface ExampleCandidate {
  item: string;
  label: string;
}

export type ExampleRejection =
  | "incomplete"          // an empty item or label
  | "self-mapping"        // the label is the item itself
  | "question"            // the only sentence writing it asks a question
  | "quoted"              // inside quotation marks: reported, not asserted
  | "no-explicit-mapping"; // not written in mapping notation in the message

export interface SupportedExample extends ExampleCandidate {
  // The sentence or line of the message that writes it.
  sentence: string;
  // The reader gave item and label the other way round; the message writes
  // them in this order, which is the one kept.
  swapped?: boolean;
}

export interface RejectedCandidate extends ExampleCandidate {
  reason: ExampleRejection;
  sentence?: string;
}

const MAPPING = String.raw`\s*(?:→|->|=>|⇒|:|=)\s*`;
const QUOTES = /["“”«»]/g;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (text: string) => String.raw`(?<![\p{L}\p{N}])${escape(text.trim())}(?![\p{L}\p{N}])`;
const normal = (text: string) => text.trim().toLowerCase();

// The message's sentences and lines, each with its terminator.
export function sentencesOf(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => line.match(/[^.?!]+[.?!]*/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
}

const insideQuotes = (sentence: string, index: number) => ((sentence.slice(0, index).match(QUOTES) ?? []).length % 2) === 1;
const isQuestion = (sentence: string) => /\?\s*$/.test(sentence);

export function supportExample(text: string, candidate: ExampleCandidate): SupportedExample | RejectedCandidate {
  const item = String(candidate.item ?? "").trim();
  const label = String(candidate.label ?? "").trim();
  if (!item || !label) return { item, label, reason: "incomplete" };
  if (normal(item) === normal(label)) return { item, label, reason: "self-mapping" };
  const direct = writtenAs(text, item, label);
  if (!("reason" in direct) || direct.reason !== "no-explicit-mapping") return direct;
  // The reader may give the pair the other way round ("H11: Plum" read as
  // Plum → H11); the message's own order is kept.
  const reversed = writtenAs(text, label, item);
  return "reason" in reversed ? direct : { ...reversed, swapped: true };
}

function writtenAs(text: string, item: string, label: string): SupportedExample | RejectedCandidate {
  const written = new RegExp(`${word(item)}${MAPPING}${word(label)}`, "iu");
  let reason: ExampleRejection = "no-explicit-mapping";
  let reasonSentence: string | undefined;
  for (const sentence of sentencesOf(text)) {
    const match = written.exec(sentence);
    if (!match) continue;
    if (isQuestion(sentence)) { reason = "question"; reasonSentence = sentence; continue; }
    if (insideQuotes(sentence, match.index)) { if (reason !== "question") { reason = "quoted"; reasonSentence = sentence; } continue; }
    return { item, label, sentence };
  }
  return { item, label, reason, ...(reasonSentence ? { sentence: reasonSentence } : {}) };
}

// The candidates the message writes as examples, and the rest with why each
// was not accepted. A pair is accepted once, however often it was read.
export function supportExamples(text: string, candidates: readonly ExampleCandidate[]): { accepted: SupportedExample[]; rejected: RejectedCandidate[] } {
  const accepted: SupportedExample[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const candidate of candidates) {
    const result = supportExample(text, candidate);
    if ("reason" in result) rejected.push(result);
    else if (!accepted.some((known) => normal(known.item) === normal(result.item) && normal(known.label) === normal(result.label))) accepted.push(result);
  }
  return { accepted, rejected };
}
