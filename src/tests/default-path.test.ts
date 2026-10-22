// Speck's default path (src/speck/respond.ts): the model's ordinary chat
// answers every message; Speck adds rule-learning notes and rule application
// only where they apply.

import assert from "node:assert/strict";
import test from "node:test";
import { respond, type RespondDependencies } from "../speck/respond.js";
import { emptyRuleLearning } from "../speck/rule-learning.js";
import type { Session } from "../speck/session.js";
import { completion, descriptors, withFixture, type Fixture } from "./support/controller-fixture.js";

type Sent = { messages: Array<{ role: string; content: string }> };

function setup(f: Fixture, answer: (sent: Sent) => string) {
  const sent: Sent[] = [];
  const readerCalls: string[] = [];
  const intake = f.runtime.modelRegistry.processor("intake")!;
  f.runtime.modelRegistry.upsert(descriptors.find((descriptor) => descriptor.id === "intake")!, {
    infer: async (request) => {
      if (request.contract?.name !== "speck-examples") return intake.infer(request);
      const [, text = ""] = request.prompt.split("USER MESSAGE:");
      readerCalls.push(text.trim());
      const pairs = [...text.matchAll(/(K\d+) → (\w+)/g)].map((match) => ({ item: match[1], label: match[2] }));
      const question = /What label does (K\d+) get/.exec(text);
      if (question) pairs.push({ item: question[1], label: question[1] }); // the reader's self-mapping
      return completion({ examples: pairs });
    }
  });
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Sent;
    sent.push(body);
    return { ok: true, json: async () => ({ message: { content: `thinking...</think>${answer(body)}` }, done_reason: "stop" }) };
  }) as unknown as typeof fetch;
  const deps: RespondDependencies = {
    registry: f.runtime.modelRegistry, readerProcessorId: "intake", fetch: fakeFetch,
    chat: { baseUrl: "http://model", model: "m", temperature: 0.2, contextSize: 16384, outputBudget: 8192, timeoutMs: 10_000 }
  };
  const session: Session = { id: "t", turns: [], rules: emptyRuleLearning(), log: [] };
  return { sent, readerCalls, deps, session };
}

const lastUser = (sent: Sent) => sent.messages.at(-1)!.content;

test("an ordinary message goes to the model exactly as it would on its own", async () => {
  await withFixture("direct", async (f) => {
    const { sent, readerCalls, deps, session } = setup(f, () => "Paris.");
    const first = await respond(session, "What is the capital of France?", deps);
    assert.equal(first.path, "plain");
    assert.equal(first.reply, "Paris.");
    assert.deepEqual(sent[0]!.messages, [{ role: "user", content: "What is the capital of France?" }]);
    assert.equal(readerCalls.length, 0, "no mapping symbol, so no reader call");
    await respond(session, "And of Spain?", deps);
    assert.deepEqual(sent[1]!.messages.map((m) => m.role), ["user", "assistant", "user"], "history only, no notes");
  });
});

test("rule learning adds notes and applies a settled rule; arithmetic between examples is plain", async () => {
  await withFixture("direct", async (f) => {
    const { sent, readerCalls, deps, session } = setup(f, (body) => {
      const message = lastUser(body);
      if (/plus/.test(message)) return "18";
      if (/K45/.test(message)) return "Teal"; // the model mislabels
      if (/K46/.test(message)) return "Teal";
      return "Noted.";
    });
    await respond(session, "Work out the rule.\nK12 → Teal\nK15 → Amber\nK22 → Teal\nK33 → Amber\nK40 → Teal\nK57 → Amber", deps);
    const sum = await respond(session, "Quick one: what is 6 plus 12?", deps);
    assert.equal(sum.path, "plain");
    assert.ok(!sent.at(-1)!.messages.some((m) => m.role === "system"));
    const k45 = await respond(session, "What label does K45 get? Answer with just the label.", deps);
    assert.equal(k45.path, "rule-corrected");
    assert.match(k45.reply, /^K45: Amber/);
    assert.equal(k45.correctedFrom, "Teal");
    assert.match(sent.at(-1)!.messages[0]!.content, /SPECK'S PREDICTION FOR THE ITEM ASKED ABOUT:\n- K45 → Amber/);
    const k46 = await respond(session, "What label does K46 get?", deps);
    assert.equal(k46.path, "rule-notes", "the model's right answer stands");
    assert.equal(k46.reply, "Teal");
    assert.ok(!session.rules.examples.some((example) => example.item === "K45" || example.item === "K46"), "the reader's self-mappings never enter state");
    // Only messages with a mapping symbol are read (a colon counts, so "Quick one: ..." is read and yields nothing);
    // the label questions have none and never reach the reader.
    assert.ok(!readerCalls.some((text) => /What label does/.test(text)), readerCalls.join(" | "));
  });
});
