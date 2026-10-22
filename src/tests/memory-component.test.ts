// The memory component (candidate): facts the user states are kept across
// conversations and come back as notes in a later one; task material and
// what the user asked not to keep do not (memory gate, 2026-10-21).

import assert from "node:assert/strict";
import test from "node:test";
import { declarativeSentences, memory, quotedIn, toldOrder } from "../speck/components/memory.js";
import type { TurnContext } from "../speck/component.js";
import { emptyRuleLearning } from "../speck/rule-learning.js";
import type { Session } from "../speck/session.js";

test("statements about the user are the declarative sentences not written in mapping notation", () => {
  assert.equal(declarativeSentences("Work out the rule: K12 → Teal, K15 → Amber. What is K40?"), "");
  assert.equal(declarativeSentences("Tags so far: M3 = gold. My name is Dana."), "My name is Dana.");
  assert.equal(declarativeSentences("Note for later: my sister Ana is allergic to peanuts."), "Note for later: my sister Ana is allergic to peanuts.");
  assert.equal(declarativeSentences("What's my name?"), "");
  assert.ok(quotedIn("don't remember it afterwards", "Only for this chat, please don't remember it afterwards: my code is 1."));
  assert.ok(!quotedIn("forget everything", "Only for this chat."));
});

// A runtime with just what the component uses: workers, grounding (every
// candidate grounded), and a shared store retrieved by any shared word.
function fakeRuntime() {
  let next = 0;
  const workers = new Map<string, unknown>();
  const shared: Array<{ content: string; sourceWorkerId: string; createdAt: string }> = [];
  const words = (text: string) => new Set(text.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
  return {
    shared,
    getWorker: (id: string) => workers.get(id) ?? null,
    createWorker: async () => { const id = `w${next++}`; workers.set(id, {}); return { id }; },
    setWorldState: async () => ({}),
    processorForRole: () => "worker",
    groundFacts: async (input: { facts: string[] }) => input.facts.map((fact) => ({ fact, grounded: true })),
    recordSharedMemory: async (input: { content: string; sourceWorkerId: string }) => { shared.push({ ...input, createdAt: new Date(Date.now() + shared.length).toISOString() }); return {}; },
    retrieveSharedMemories: async (input: { query: string; excludeSourceWorkerId?: string }) => {
      const query = words(input.query);
      return shared.filter((entry) => entry.sourceWorkerId !== input.excludeSourceWorkerId && [...words(entry.content)].some((word) => query.has(word)))
        .map((object) => ({ object, score: 0.5 }));
    }
  };
}

// The reader and checker: candidates are the statement's sentences;
// retention follows "don't keep".
const registry = {
  infer: async (request: { contract: { name: string }; prompt: string }) => {
    const statement = request.prompt.split("USER STATEMENT:\n")[1]?.split("\n\nCANDIDATES:")[0] ?? "";
    if (request.contract.name === "speck-disclosure-extraction") return { structured: { facts: statement.match(/[^.]+\./g)?.map((s) => s.trim()) ?? [] } };
    if (request.contract.name === "speck-disclosure-validation") {
      const candidates = request.prompt.split("CANDIDATES:\n")[1]!.split("\n").map((line) => line.replace(/^\d+\. /, ""));
      return { structured: { facts: candidates.map((fact, index) => ({ candidate: index + 1, fact })) } };
    }
    const quote = /don't keep this/i.exec(statement)?.[0] ?? "";
    return { structured: { quote, retention: quote ? "only for this task" : "not mentioned" } };
  }
};

function context(runtime: ReturnType<typeof fakeRuntime>, session: Session, message: string): TurnContext {
  return {
    session, message, turn: session.turns.length / 2, history: session.turns, registry: registry as never, runtime: runtime as never,
    readerProcessorId: "intake", chat: {} as never, scratch: new Map()
  };
}

async function turn(runtime: ReturnType<typeof fakeRuntime>, session: Session, message: string): Promise<string | null> {
  const at = context(runtime, session, message);
  await memory.observe!(at);
  const notes = await memory.contribute!(at);
  session.turns.push({ role: "user", content: message }, { role: "assistant", content: "ok" });
  return notes;
}

const newSession = (id: string): Session => ({ id, turns: [], rules: emptyRuleLearning(), state: {}, log: [] });

test("a fact comes back in a later conversation, not in its own, and without dates", async () => {
  const runtime = fakeRuntime();
  const first = newSession("a");
  assert.equal(await turn(runtime, first, "I work as a nurse in Springfield."), null);
  assert.equal(await turn(runtime, first, "What do I do as a nurse?"), null, "this conversation's facts are in its history already");
  const notes = await turn(runtime, newSession("b"), "What do I do as a nurse?");
  assert.match(notes ?? "", /^- I work as a nurse in Springfield\.$/m);
  assert.doesNotMatch(notes ?? "", /\d{4}-\d{2}-\d{2}/);
});

test("task material in mapping notation and facts the user asked not to keep are not shared", async () => {
  const runtime = fakeRuntime();
  const first = newSession("a");
  await turn(runtime, first, "Work out the rule: K12 → Teal, K15 → Amber. What is K40?");
  await turn(runtime, first, "Don't keep this after today. My locker code is Teal.");
  assert.equal(runtime.shared.length, 0, runtime.shared.map((entry) => entry.content).join(" | "));
  assert.equal(await turn(runtime, newSession("b"), "What is my locker code, and what is K12 Teal?"), null);
});

test("memory is inert without a runtime and never fails a turn", async () => {
  const session = newSession("a");
  const bare = context(undefined as never, session, "I work as a nurse.");
  await memory.observe!({ ...bare, runtime: undefined });
  assert.equal(await memory.contribute!({ ...bare, runtime: undefined }), null);
  const broken = { ...fakeRuntime(), retrieveSharedMemories: async () => { throw new Error("embedding server down"); } };
  const at = context(broken as never, session, "I work as a nurse.");
  await memory.observe!(at);
  assert.equal(await memory.contribute!(at), null);
});

test("facts are recalled in the order they were told, even when stored in the same instant", () => {
  const at = "2026-10-21T00:00:00.000Z";
  const told = [
    { createdAt: at, data: { position: 1 }, content: "I started at a library this week" },
    { createdAt: "2026-10-20T00:00:00.000Z", data: {}, content: "I work at a bakery." },
    { createdAt: at, data: { position: 0 }, content: "I left the bakery" }
  ];
  assert.deepEqual([...told].sort(toldOrder).map((fact) => fact.content), ["I work at a bakery.", "I left the bakery", "I started at a library this week"]);
});
