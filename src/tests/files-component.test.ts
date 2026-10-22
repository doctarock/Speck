// The files component (candidate): a file tool the Tool Caller chooses runs,
// and only its successful results become notes (files gate, 2026-10-21).

import assert from "node:assert/strict";
import test from "node:test";
import { files } from "../speck/components/files.js";
import type { TurnContext } from "../speck/component.js";
import { NoApplicableToolError } from "../runtime/speck-runtime.js";
import { emptyRuleLearning } from "../speck/rule-learning.js";

type Proposal = { name: string; arguments: Record<string, unknown> } | null;

function fakeRuntime(proposals: Proposal[], outcomes: Record<string, { outcome: string; output?: unknown; error?: string }>, risk = "read-only") {
  const executed: string[] = [];
  const asked: Array<{ processorId?: string; allowedTools?: readonly string[] }> = [];
  return {
    executed, asked,
    toolRegistry: {
      list: () => ["list_files", "read_file"].map((name) => ({ name, risk })),
      resolve: (intent: { intent: string }) => ({ definition: { name: intent.intent, risk } })
    },
    processorForRole: () => "worker-model",
    createWorker: async () => ({ id: "w" }),
    proposeToolIntent: async (input: { processorId?: string; allowedTools?: readonly string[]; request: string }) => {
      asked.push(input);
      const next = proposals.shift();
      if (!next) throw new NoApplicableToolError(input.request);
      return { intent: { intent: next.name, arguments: next.arguments } };
    },
    executeToolIntent: async (input: { intent: { intent: string; arguments: Record<string, unknown> } }) => {
      const key = `${input.intent.intent} ${JSON.stringify(input.intent.arguments)}`;
      executed.push(key);
      const found = outcomes[key] ?? { outcome: "failed", error: "not found" };
      return { record: { actualOutcome: found.outcome, output: found.output ?? null, error: found.error ?? null } };
    }
  };
}

function context(runtime: unknown, message: string): TurnContext {
  return {
    session: { id: "s", turns: [], rules: emptyRuleLearning(), state: {}, log: [] }, message, turn: 0, history: [],
    registry: {} as never, runtime: runtime as never, readerProcessorId: "intake", chat: {} as never, scratch: new Map()
  };
}

test("a file the Tool Caller reads becomes notes; the worker model routes, with only the file tools offered", async () => {
  const runtime = fakeRuntime([{ name: "read_file", arguments: { scope: "workspace", file: "notes/todo.txt" } }],
    { 'read_file {"scope":"workspace","file":"notes/todo.txt"}': { outcome: "succeeded", output: { content: "Call the plumber" } } });
  const notes = await files.contribute!(context(runtime, "What's in notes/todo.txt?"));
  assert.match(notes ?? "", /Call the plumber/);
  assert.equal(runtime.asked[0]!.processorId, "worker-model");
  assert.deepEqual(runtime.asked[0]!.allowedTools, ["list_files", "read_file"]);
});

test("no tool, a failed tool, or a repeated operation adds nothing", async () => {
  assert.equal(await files.contribute!(context(fakeRuntime([], {}), "What is 12 times 12?")), null);
  const failing = fakeRuntime([{ name: "list_files", arguments: { directory: "workspace" } }], {});
  assert.equal(await files.contribute!(context(failing, "Q12: Red, Q17: Blue")), null, "a failed call is not shown");
  const repeating = fakeRuntime([{ name: "list_files", arguments: {} }, { name: "list_files", arguments: {} }],
    { "list_files {}": { outcome: "succeeded", output: { files: ["a.txt"] } } });
  await files.contribute!(context(repeating, "What files do I have?"));
  assert.equal(repeating.executed.length, 1);
});

test("a tool that is not read-only never runs, and without a runtime the component is inert", async () => {
  const mutating = fakeRuntime([{ name: "read_file", arguments: { file: "x" } }], {}, "reversible-mutation");
  assert.equal(await files.contribute!(context(mutating, "Read x")), null);
  assert.equal(mutating.executed.length, 0);
  assert.equal(await files.contribute!(context(undefined, "Read x")), null);
});
