// The amounts ledger (candidate): numbers the user states, read from the
// dependency parse (recorded in fixtures/ledger-parses.json), kept in order
// and shown when a message is about them; no language model, no word lists.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ledger, readEntries } from "../speck/components/ledger.js";
import type { TurnContext } from "../speck/component.js";
import type { ParsedToken } from "../speck/parse.js";
import { emptyRuleLearning } from "../speck/rule-learning.js";
import type { Session } from "../speck/session.js";

const PARSES = JSON.parse(fs.readFileSync(path.resolve("src", "tests", "fixtures", "ledger-parses.json"), "utf8")) as Record<string, ParsedToken[]>;

test("numbers are read with what they count and whose they are; codes, questions and dates are not", () => {
  const read = (text: string) => readEntries(text, PARSES[text]!, 1).map((entry) => [entry.value, entry.counted, entry.owner]);
  assert.deepEqual(read("My piggy bank has 25 dollars in it."), [["25", "dollars", "My piggy bank"]]);
  assert.deepEqual(read("Tom has 10 marbles and Sara has 7 marbles."), [["10", "marbles", "Tom"], ["7", "marbles", "Sara"]]);
  assert.deepEqual(read("Q12: Red, Q17: Blue."), []);
  assert.deepEqual(read("Quick one: what is 5 times 11?"), []);
  assert.ok(!read("I was born in 1990 and I live at number 42.").some(([value]) => value === "1990"));
});

async function turn(session: Session, message: string): Promise<string | null> {
  const context: TurnContext = {
    session, message, turn: session.turns.length / 2, history: session.turns, registry: {} as never,
    readerProcessorId: "intake", chat: {} as never, scratch: new Map()
  };
  await ledger.observe!(context);
  const notes = await ledger.contribute!(context);
  session.turns.push({ role: "user", content: message }, { role: "assistant", content: "ok" });
  return notes;
}

test("the ledger is shown for a message about it, in the order told, and not otherwise", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const text = (JSON.parse(init.body) as { text: string }).text;
    return { ok: true, json: async () => ({ ok: true, tokens: PARSES[text] }) };
  }) as unknown as typeof fetch;
  try {
    const session: Session = { id: "s", turns: [], rules: emptyRuleLearning(), state: {}, log: [] };
    await turn(session, "My piggy bank has 25 dollars in it.");
    const deposit = await turn(session, "I put in 12 more dollars today.");
    assert.match(deposit ?? "", /1\. message 1: 25 dollars \(My piggy bank\) — "My piggy bank has 25 dollars in it\."\n2\. message 2: 12 dollars \(I\) — "I put in 12 more dollars today\."/);
    assert.ok(await turn(session, "How much is in it now?"), "a question right after an addition is about it");
    assert.equal(await turn(session, "What is the capital of Peru?"), null, "a message about something else is untouched");
  } finally {
    globalThis.fetch = original;
  }
});

test("without the parse sidecar the ledger is inert", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("sidecar down"); }) as unknown as typeof fetch;
  try {
    const session: Session = { id: "s", turns: [], rules: emptyRuleLearning(), state: {}, log: [] };
    assert.equal(await turn(session, "My piggy bank has 25 dollars in it."), null);
  } finally {
    globalThis.fetch = original;
  }
});
