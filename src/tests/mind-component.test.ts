// The mind (2026-10-22): facts kept in one persistent worker across
// conversations, recalled in a later one, working memory released when a
// conversation begins, and an older fact retired when a new one contradicts
// it (belief revision through the qualified paired judgment).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeMind, mindOptions } from "../speck/components/mind.js";
import type { TurnContext } from "../speck/component.js";
import type { ParsedToken } from "../speck/parse.js";
import { emptyRuleLearning } from "../speck/rule-learning.js";
import type { Session } from "../speck/session.js";
import { PAIRED_ENTAILMENT_CORPUS_VERSION, QUALIFICATION_THRESHOLDS, type Qualification } from "../metacognition/qualification.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import { completion } from "./support/controller-fixture.js";

const PARSES = JSON.parse(fs.readFileSync(path.resolve("src", "tests", "fixtures", "mind-parses.json"), "utf8")) as Record<string, ParsedToken[]>;

// A runtime whose reader states each sentence of a message as a fact, and a
// checker (qualified for paired-entailment) that finds the two cars opposed.
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-mind-"));
  const runtime = new SpeckRuntime({
    databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory,
    modelRuntime: { processors: [], roles: { intake: "intake", planner: "worker", worker: "worker", toolCaller: "", specialists: {}, checker: "checker" } }
  });
  const reader = {
    infer: async (request: { contract?: { name: string }; prompt: string; input?: { premise: string; hypothesis: string } }) => {
      const name = request.contract?.name;
      if (name === "speck-disclosure-extraction") return completion({ facts: (request.prompt.split("USER STATEMENT:\n")[1] ?? "").match(/[^.]+\./g)?.map((s) => s.trim()) ?? [] });
      if (name === "speck-disclosure-validation") return completion({ facts: [...request.prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => ({ candidate: Number(match[1]), fact: match[2]! })) });
      if (name === "speck-retention-evidence") return completion({ quote: "", retention: "not mentioned" });
      if (name === "speck-atomic-entailment") {
        const { premise, hypothesis } = request.input!;
        const negated = /not|It is not true/.test(hypothesis);
        const clash = /Subaru/.test(premise) && /Mazda/.test(hypothesis);
        return completion({ label: clash ? (negated ? "entailment" : "contradiction") : "neutral" });
      }
      return completion({});
    }
  };
  for (const id of ["intake", "worker", "checker"]) {
    runtime.registerModelProcessor({ id, provider: "ollama", model: `stub-${id}`, baseUrl: "http://stub", tier: 1, specialties: [], hardware: "local", enabled: true } as never, reader as never);
  }
  const qualified: Qualification = {
    capability: "paired-entailment", corpus: PAIRED_ENTAILMENT_CORPUS_VERSION, qualified: true, measuredAt: new Date().toISOString(), repetitions: 1,
    overall: { correct: 1, total: 1 }, byLabel: { entailment: { correct: 1, total: 1 }, contradiction: { correct: 1, total: 1 }, neutral: { correct: 1, total: 1 } },
    confusion: {} as never, negationConsistency: { correct: 1, total: 1 }, lowerBounds: { overall: 1, contradiction: 1, negationConsistency: 1 }, meanLatencyMs: 1, thresholds: QUALIFICATION_THRESHOLDS
  };
  runtime.processorCompetence.recordQualification(runtime.modelRegistry.modelKey("checker"), qualified);
  return { runtime, directory };
}

async function say(runtime: SpeckRuntime, session: Session, message: string, mind = makeMind("memory", { activation: true, context: true, beliefs: true, consolidation: true })): Promise<{ notes: string | null; scratch: Map<string, unknown> }> {
  const context: TurnContext = {
    session, message, turn: session.turns.filter((turn) => turn.role === "user").length, history: session.turns,
    registry: runtime.modelRegistry, runtime, readerProcessorId: "intake", chat: {} as never, scratch: new Map()
  };
  await mind.observe!(context);
  const notes = await mind.contribute!(context);
  session.turns.push({ role: "user", content: message }, { role: "assistant", content: "ok" });
  return { notes, scratch: context.scratch };
}

const session = (id: string): Session => ({ id, turns: [], rules: emptyRuleLearning(), state: {}, log: [] });

test("a fact is kept across conversations: recalled in a later one, not in its own", async () => {
  const { runtime, directory } = setup();
  try {
    const first = session("a");
    assert.equal((await say(runtime, first, "I play the cello.")).notes, null);
    const later = await say(runtime, session("b"), "Which instrument do I play, the cello?");
    assert.match(later.notes ?? "", /- I play the cello\./);
  } finally { runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a new conversation starts with an empty working memory", async () => {
  const { runtime, directory } = setup();
  try {
    await say(runtime, session("a"), "I play the cello.");
    await say(runtime, session("b"), "Which instrument do I play, the cello?");
    const mindId = runtime.listWorkers().find((worker) => worker.objective.constraints.includes("speck:mind"))!.id;
    assert.ok(runtime.getWorker(mindId)!.workingMemory.length > 0, "recall admitted facts to working memory");
    await say(runtime, session("c"), "Hello again.");
    assert.equal(runtime.getWorker(mindId)!.workingMemory.length, 0);
  } finally { runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a fact that contradicts an older one retires it; without belief revision both stay", async () => {
  mindOptions.parse = async (text) => PARSES[text] ?? null;
  try {
    for (const beliefs of [true, false]) {
      const { runtime, directory } = setup();
      try {
        const mind = makeMind("memory", { activation: true, context: true, beliefs, consolidation: true });
        await say(runtime, session("a"), "I drive a red Mazda.", mind);
        await say(runtime, session("b"), "I drive a blue Subaru.", mind);
        const later = await say(runtime, session("c"), "Do I drive a Mazda or a Subaru?", mind);
        assert.match(later.notes ?? "", /blue Subaru/);
        if (beliefs) assert.doesNotMatch(later.notes ?? "", /red Mazda/, "the retired fact is not recalled");
        else assert.match(later.notes ?? "", /red Mazda/);
      } finally { runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
    }
  } finally { mindOptions.parse = (await import("../speck/parse.js")).parseText; }
});
