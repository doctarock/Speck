import assert from "node:assert/strict";
import test from "node:test";
import { GROUNDING_MINIMUM_BASELINE, groundFacts, lexicallyGrounded, type GroundingEncoder } from "../memory/grounding.js";

// A transparent stand-in for an embedding model: each content word maps to a
// concept dimension and listed synonyms share one, so paraphrases are similar
// and function words carry no meaning, as with a real encoder.
const SYNONYMS: Record<string, string> = { oz: "australia", australian: "australia", reside: "live", lives: "live", living: "live", restarts: "restart" };
const FUNCTION_WORDS = new Set(["a", "an", "the", "i", "m", "am", "is", "are", "and", "to", "in", "of", "for", "on", "me", "you", "user", "s", "hi", "can", "please", "what", "which", "how", "this", "it", "from"]);
const encoder: GroundingEncoder = {
  async encode(texts) {
    const vocabulary = new Map<string, number>();
    const tokenize = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !FUNCTION_WORDS.has(word)).map((word) => SYNONYMS[word] ?? word);
    for (const text of texts) for (const word of tokenize(text)) if (!vocabulary.has(word)) vocabulary.set(word, vocabulary.size);
    return {
      encoder: "test:concepts",
      vectors: texts.map((text) => {
        const vector = new Array(vocabulary.size).fill(0);
        for (const word of tokenize(text)) vector[vocabulary.get(word)!] += 1;
        return vector;
      })
    };
  }
};

const history = [
  "Can you summarise yesterday's meeting notes?", "Please restart the web server.", "What time is it in London?",
  "Remind me to call the plumber tomorrow.", "Draft an email to the landlord about the heater.", "How many tasks are queued?",
  "Show me the latest build log.", "Translate this paragraph into French.", "Book a table for two on Friday.",
  "Which files changed in the last commit?"
];

test("grounding falls back to the lexical rule until memory holds enough past statements", async () => {
  const { decisions } = await groundFacts({
    facts: ["The user's name is Dana.", "I am a helpful AI assistant."],
    statement: "My name is Dana.", pastStatements: history.slice(0, GROUNDING_MINIMUM_BASELINE - 1), encoder
  });
  assert.deepEqual(decisions.map((decision) => [decision.method, decision.grounded]), [["lexical-cold-start", true], ["lexical-cold-start", false]]);
});

test("grounding admits facts that stand above the user's baseline, including paraphrases", async () => {
  const statement = "Hi, I'm Dana and I'm from Oz.";
  const { decisions, encoder: used } = await groundFacts({
    facts: ["The user lives in Australia.", "I am a helpful AI assistant designed to assist you."],
    statement, pastStatements: history, encoder
  });
  assert.equal(used, "test:concepts");
  const [paraphrase, persona] = decisions;
  assert.equal(paraphrase!.method, "baseline");
  assert.equal(paraphrase!.baselineSamples, history.length);
  assert.ok(paraphrase!.grounded, "a paraphrase of what the user said is grounded");
  // The signals disagree on a paraphrase, so it is kept but uncertain.
  assert.equal(paraphrase!.certainty, "uncertain");
  assert.deepEqual([paraphrase!.semantic, paraphrase!.lexical], [true, false]);
  assert.equal(persona!.certainty, "unstated");
  assert.equal(lexicallyGrounded("The user lives in Australia.", statement), false, "the lexical rule would have rejected it");
  assert.ok(!persona!.grounded, "a statement the user never made stays at baseline");
  assert.ok(persona!.score! <= persona!.threshold!);
});

test("the grounding bar is set by the user's own history, not a fixed similarity", async () => {
  const fact = "The user restarts the web server every morning.";
  const statement = "I restart the web server every morning.";
  const unrelated = await groundFacts({ facts: [fact], statement, pastStatements: history, encoder });
  const repetitive = await groundFacts({
    facts: [fact], statement,
    pastStatements: history.map((entry, index) => index % 2 ? `Restart the web server every morning, reminder ${index}.` : entry), encoder
  });
  assert.ok(repetitive.decisions[0]!.threshold! > unrelated.decisions[0]!.threshold!, "a user who often says similar things raises the bar");
});

test("contraction fragments do not count as shared words", () => {
  const statement = "Hi, I'm Dana and I'm from Oz.";
  assert.equal(lexicallyGrounded("I'm from Oz, and I'm from a small town in the Midwest.", statement), false);
  assert.equal(lexicallyGrounded("I'm from Oz.", statement), true);
});
